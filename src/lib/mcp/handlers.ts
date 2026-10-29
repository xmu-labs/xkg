/**
 * MCP tool handlers.
 *
 * Every handler has the same shape — `(user, args) => Promise<string>` — and
 * is deliberately free of HTTP concerns: no NextRequest/NextResponse, no
 * status codes, no transport helpers. That keeps them importable from tests,
 * which is why they live here rather than inside the route. Before this split
 * they were module-private in `app/api/mcp/route.ts`, so the only way to
 * assert anything about them was to read the route as text and grep it.
 *
 * Dispatch goes through the HANDLERS registry at the bottom rather than a
 * switch, so adding a tool means one schema entry in ./tools and one registry
 * entry here, and the `Record<ToolName, ...>` type makes a mismatch between
 * the two a compile error instead of a runtime "Unknown tool".
 */

import type { User } from "@/lib/db";
import { env } from "@/lib/env";
import { githubGet, githubPut, githubDelete, readFile, updateIndexEntry } from "@/lib/github";
import { recordApplyEvent } from "@/lib/apply-events";
import { recordSurfaceEvents, recordWhereEvent } from "@/lib/surface-events";
import { safeFetch } from "@/lib/fetch-source";
import { consumeQuota } from "@/lib/rate-limit";
import { renderEvidenceSection, renderSourceSection, sourceFrontmatter } from "@/lib/evidence";
import { extractCapture, formatDate, buildIndexRow, rankByRelevance, generateApplicationSuggestions, generatePlan, curateSingle, detectSourceType, filterByDateRange, paginate, pageFooter, matchIndexRows, llmSettings } from "@/lib/llm";
import { linkCapture } from "@/lib/linking";
import { matchCapture, whereLine, writeWhereSection } from "@/lib/where";
import { appendHandoffLog, queueStrongFit } from "@/lib/handoffs";
import { appliedHandoff, closeHandoff, outcomeOf, recordAnswer } from "@/lib/handoff-outcomes";
import { handoffOffer } from "@/lib/handoff-offer";
import { repoName } from "@/lib/code-repos";
import { briefingCandidate, formatBriefing, selectRanked, type BriefingCandidate } from "@/lib/briefing";
import { LEDGER_PATH, appendLedgerRow, ledgerHasCommit, weeklyApplyStats } from "@/lib/ledger";
import { synthesizeTopic } from "@/lib/synthesis";
import type { ExtractedCapture } from "@/lib/types";
import type { ToolName } from "./tools";

export async function handleCapture(user: User, args: { content: string; title?: string }): Promise<string> {
  if (!user.llm_api_key) throw new Error(`API key not configured. Complete onboarding at ${env.appUrl}/onboard`);
  if (!user.github_repo) throw new Error("Knowledge repo not configured");

  // Same ceiling as the web route, and the same identifier, so the two paths
  // share one budget. This is the likelier abuse path: a stolen MCP key reaches
  // capture directly, and every call spends the owner's LLM credits.
  const quota = await consumeQuota(`capture:user:${user.id}`);
  if (!quota.allowed) {
    throw new Error(
      `Rate limit reached (${quota.limit} captures/hour). Try again in ${Math.ceil(quota.resetIn / 60)} minute(s).`,
    );
  }

  const sourceType = detectSourceType(args.content);
  const capture: ExtractedCapture = await extractCapture(user.llm_api_key, args.content, args.title, llmSettings(user));
  // Runs alongside writing and linking; never throws.
  const matching = matchCapture(user, capture);

  const date = formatDate();
  const filename = `${date}-${capture.slug}.md`;

  // Compact Markdown for MCP: no raw capture section, but the checked source
  // text is kept so the evidence quotes can be re-checked later.
  const evidence = renderEvidenceSection(capture);
  const markdown = [
    `---`,
    `date: ${date}`,
    `source: ${capture.inferredTitle}`,
    `type: ${capture.inferredType}`,
    `source_type: ${sourceType}`,
    `tags: ${capture.tags.join(", ")}`,
    `status: inbox`,
    `lowConfidence: ${capture.lowConfidence}`,
    ...sourceFrontmatter(capture),
    `---`,
    ``,
    `# ${capture.inferredTitle}`,
    ``,
    `## Core idea`,
    capture.coreIdea,
    ``,
    `## Key takeaways`,
    ...capture.takeaways.map((t) => `- ${t}`),
    ``,
    `## Quotes`,
    capture.quotes.length > 0
      ? capture.quotes.map((q) => `> "${q}"`).join("\n\n")
      : "_none_",
    ``,
    `## Applied to`,
    capture.appliedTo ?? "_not immediately obvious_",
    ``,
    ...(evidence ? [evidence] : []),
    // Before the source text, so auto-linking edits this section and never a
    // heading that happens to appear inside the stored source.
    `## Links to memory`,
    `_none yet_`,
    ``,
    renderSourceSection(capture),
  ].join("\n");

  await githubPut(user.github_token, user.github_repo, `inbox/${filename}`, markdown, `capture: add ${filename}`);

  // Update INDEX.md
  const row = buildIndexRow(date, capture, filename, sourceType);
  const existing = await readFile(user.github_token, user.github_repo, "INDEX.md");
  if (existing) {
    await githubPut(user.github_token, user.github_repo, "INDEX.md", existing.content + row, "capture: update index", existing.sha);
  }

  // Auto-link to related captures
  let linkedCount = 0;
  if (existing) {
    try {
      const related = await linkCapture(user.llm_api_key!, user.github_token, user.github_repo, capture, filename, "inbox", existing.content, llmSettings(user));
      linkedCount = related.length;
    } catch {
      // Linking is best-effort — don't fail the capture
    }
  }

  const where = await matching;
  const wrote = where ? await writeWhereSection(user.github_token, user.github_repo, `inbox/${filename}`, where) : false;
  // The agent only sees the fit once the section is written.
  const line = wrote && where ? whereLine(where) : null;
  if (where) await recordWhereEvent(user.id, `inbox/${filename}`, where, line !== null);
  // A Strong fit the agent was told about waits for the next coding session in that repo.
  const waitingIn = line && where ? await queueStrongFit(user, `inbox/${filename}`, where, date) : null;

  // Append inbox count as a nudge
  const inboxRes = await githubGet<Array<{ name: string }>>(user.github_token, user.github_repo, "inbox");
  const inboxCount = inboxRes.ok && inboxRes.data
    ? inboxRes.data.filter((f) => f.name.endsWith(".md")).length
    : 0;

  let result = `Captured: ${capture.inferredTitle}\nFile: inbox/${filename}\nTags: ${capture.tags.join(", ")}`;
  if (linkedCount > 0) {
    result += `\nLinked to ${linkedCount} related capture(s).`;
  }
  if (line) result += `\n${line}`;
  if (waitingIn) result += `\nQueued for your next coding session in ${waitingIn}.`;
  if (inboxCount > 0) {
    result += `\n\n---\n📬 You have ${inboxCount} item(s) in your inbox. Use list_inbox to review and apply them.`;
  }
  return result;
}

export async function handleListInbox(
  user: User,
  args: { since?: string; until?: string; offset?: number; limit?: number } = {},
): Promise<string> {
  if (!user.github_repo) return "Knowledge repo not configured.";
  const res = await githubGet<Array<{ name: string }>>(user.github_token, user.github_repo, "inbox");
  if (!res.ok || !res.data) return "Inbox is empty.";
  // Sort by name (date-prefixed → chronological) for a stable paging order.
  const allMd = res.data.filter((f) => f.name.endsWith(".md")).sort((a, b) => a.name.localeCompare(b.name));
  if (allMd.length === 0) return "Inbox is empty.";

  const filtered = filterByDateRange(allMd, args.since, args.until);
  if (filtered.length === 0) {
    return `No captures in inbox match the given date range (${allMd.length} total in inbox).`;
  }

  // Page through filtered results; only the current page is read for summaries.
  const page = paginate(filtered, args.offset ?? 0, args.limit ?? 10);
  const summaries = await Promise.all(
    page.items.map(async (f, i) => {
      const n = page.offset + i + 1;
      const file = await readFile(user.github_token, user.github_repo!, `inbox/${f.name}`);
      if (!file) return `${n}. ${f.name}\n   (could not read)`;

      const fmMatch = file.content.match(/^---\n([\s\S]*?)\n---/);
      const fm = fmMatch?.[1] ?? "";
      const source = fm.match(/^source:\s*(.+)$/m)?.[1] ?? "Unknown";
      const type = fm.match(/^type:\s*(.+)$/m)?.[1] ?? "unknown";
      const tags = fm.match(/^tags:\s*(.+)$/m)?.[1] ?? "";

      const coreMatch = file.content.match(/## Core idea\n([\s\S]*?)(?=\n##|$)/);
      const coreIdea = coreMatch?.[1]?.trim().slice(0, 120) ?? "";

      return `${n}. ${f.name}\n   Source: ${source}\n   Type: ${type} | Tags: ${tags}\n   Core idea: ${coreIdea}`;
    }),
  );

  return `${page.total} capture(s) in inbox:\n\n${summaries.join("\n\n")}${pageFooter(page, "list_inbox")}`;
}

export async function handleSearch(
  user: User,
  args: { query?: string; tag?: string; since?: string; until?: string; offset?: number; limit?: number },
): Promise<string> {
  if (!user.github_repo) return "Knowledge repo not configured.";
  const existing = await readFile(user.github_token, user.github_repo, "INDEX.md");
  if (!existing) return "No captures yet.";

  const lines = existing.content
    .split("\n")
    .filter((l) => l.startsWith("|") && !l.startsWith("| Date") && !l.startsWith("|---"));

  // Hard filters first: tag membership, then the date window (the row's
  // leading date column drives filterByDateRange via a synthetic `name`).
  const tag = args.tag?.toLowerCase();
  const tagged = tag ? lines.filter((l) => l.toLowerCase().includes(tag)) : lines;
  const dated = tagged.map((row) => ({ name: (row.match(/\|\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? "") + " " + row, row }));
  const inScope = filterByDateRange(dated, args.since, args.until).map((m) => m.row);

  // Then rank by query tokens (OR + relevance). An empty query lists all.
  const query = args.query ?? "";
  const matches = matchIndexRows(inScope, query);

  if (matches.length === 0) {
    const scope = args.since || args.until ? " in the given date range" : "";
    const what = query.trim() ? `matches for "${query.trim()}"` : "captures";
    return `No ${what}${scope}.`;
  }

  const page = paginate(matches, args.offset ?? 0, args.limit ?? 20);
  const header = query.trim() ? `${page.total} match(es):` : `${page.total} capture(s):`;
  return `${header}\n${page.items.join("\n")}${pageFooter(page, "search_captures")}`;
}

export async function handleReadCapture(user: User, args: { filename: string }): Promise<string> {
  if (!user.github_repo) return "Knowledge repo not configured.";
  const path = args.filename.includes("/") ? args.filename : `inbox/${args.filename}`;
  const file = await readFile(user.github_token, user.github_repo, path);
  if (!file) return `File not found: ${path}. Use list_inbox to see available captures.`;
  return file.content;
}

/** Appended wherever xkg suggests a capture, so the agent closes the loop after committing. */
export const APPLY_HINT =
  "When you commit a change that applies a capture, add the trailer `xkg-capture: <filename>` to the commit message, then call `apply_capture` with the filename and the commit sha (`git rev-parse HEAD`). xkg counts each capture and commit once.";

/** Longest reason kept from applied_note: one line, so it can't add sections to the capture. */
const NOTE_MAX = 200;

/**
 * Records that a capture was applied. The first time, it moves the capture from
 * inbox/ to applied/. Applying an already-applied capture adds another entry to
 * its application log, so each commit it drives is counted.
 */
export async function handleApplyCapture(
  user: User,
  args: {
    filename: string; applied_note?: string; target_file?: string; outcome?: string; plan_file?: string; commit_sha?: string;
    repo?: string; reason?: string; confidence?: string; files?: string[];
  },
  ctx: ToolContext = {},
): Promise<string> {
  if (!user.github_repo) return "Knowledge repo not configured.";
  if (args.commit_sha !== undefined && !/^[0-9a-f]{7,40}$/i.test(args.commit_sha)) {
    return `commit_sha must be a git commit hash (7 to 40 hex characters), got: ${args.commit_sha}`;
  }
  // declined, done, later and reverted are answers to a handoff, never an apply
  const outcome = outcomeOf(args.outcome);
  if (outcome && outcome !== "applied") return recordAnswer(user, { ...args, outcome });
  const filename = args.filename.replace(/^(?:inbox|applied)\//, "");
  const note = args.applied_note?.replace(/\s+/g, " ").trim().slice(0, NOTE_MAX) || undefined;
  const inboxPath = `inbox/${filename}`;
  const appliedPath = `applied/${filename}`;
  const inboxFile = await readFile(user.github_token, user.github_repo, inboxPath);
  const file = inboxFile ?? await readFile(user.github_token, user.github_repo, appliedPath);
  if (!file) return `File not found: ${inboxPath} or ${appliedPath}. Use list_inbox to see available captures.`;
  const today = new Date().toISOString().split("T")[0]!;

  // A handoff waiting for this capture is done once it's applied
  const handoff = await appliedHandoff(user, filename, args, today);
  const handoffNote = handoff ? `. The handoff in ${handoff.repo} is done.` : "";

  // The server's count, for the apply metric across users. The repo stays the record.
  // Safe to repeat: the same capture and commit is counted once.
  const recordEvent = async (): Promise<string> => {
    try {
      await recordApplyEvent({ userId: user.id, filename, commit: args.commit_sha, harness: ctx.harness ?? "unknown", hasWhy: Boolean(note) });
      return "";
    } catch (err) {
      console.error(`apply_events insert failed for user ${user.id}:`, err instanceof Error ? err.message : err);
      return " (not counted on the server)";
    }
  };

  // The git post-commit hook and the agent may both report the same commit; count it once.
  // The server still hears the repeat, so the agent's name and reason join the hook's report.
  if (args.commit_sha && !inboxFile) {
    const ledger = await readFile(user.github_token, user.github_repo, LEDGER_PATH);
    if (ledger && ledgerHasCommit(ledger.content, filename, args.commit_sha)) {
      // The first report may have come without the repo; this one closes the handoff
      if (handoff) {
        try {
          await githubPut(user.github_token, user.github_repo, appliedPath, appendHandoffLog(file.content, handoff.line), `handoff: applied ${filename}`, file.sha);
          await closeHandoff(user, appliedPath, handoff, true, today);
        } catch (err) {
          console.error("[handoff] close failed:", err instanceof Error ? err.message : err);
        }
      }
      return `Already recorded: ${filename} (${args.commit_sha.slice(0, 7)})${await recordEvent()}${handoffNote}`;
    }
  }

  let content = file.content.replace(/^status:\s*inbox$/m, "status: applied");
  if (note && inboxFile) {
    content = content.replace(
      /## Applied to\n[\s\S]*?(?=\n##|$)/,
      `## Applied to\n${note}`,
    );
  }

  // Add application log
  const logLines = [`- **Applied:** ${today}`];
  if (args.commit_sha) logLines.push(`- **Commit:** ${args.commit_sha}`);
  if (args.target_file) logLines.push(`- **Target:** ${args.target_file}`);
  if (note) logLines.push(`- **Note:** ${note}`);
  if (args.plan_file) logLines.push(`- **Plan:** ${args.plan_file}`);
  logLines.push(`- **Outcome:** ${args.outcome ?? "_pending_"}`);

  if (content.includes("## Application log\n")) {
    // Applied before: add this entry at the end of the existing log
    content = content.replace(/(## Application log\n[\s\S]*?)\n*(?=\n## |$)/, `$1\n\n${logLines.join("\n")}\n`);
  } else {
    // Insert application log before "Links to memory" or at the end
    const appLogSection = `\n## Application log\n${logLines.join("\n")}\n`;
    if (content.includes("## Links to memory")) {
      content = content.replace("## Links to memory", `${appLogSection}\n## Links to memory`);
    } else {
      content = content.trimEnd() + `\n${appLogSection}`;
    }
  }
  if (handoff) content = appendHandoffLog(content, handoff.line);

  const commitRef = args.commit_sha ? ` (${args.commit_sha.slice(0, 7)})` : "";
  const recordInLedger = async (): Promise<string> => {
    try {
      const ledger = await readFile(user.github_token, user.github_repo!, LEDGER_PATH);
      const row = { date: today, capture: filename, commit: args.commit_sha, target: args.target_file };
      await githubPut(user.github_token, user.github_repo!, LEDGER_PATH, appendLedgerRow(ledger?.content ?? null, row), `ledger: ${filename}${commitRef}`, ledger?.sha);
      return "";
    } catch {
      return ` (not counted in ${LEDGER_PATH}: the ledger write failed)`;
    }
  };

  if (!inboxFile) {
    await githubPut(user.github_token, user.github_repo, appliedPath, content, `apply again: ${filename}${commitRef}`, file.sha);
    const notes = (await recordInLedger()) + (await recordEvent());
    if (handoff) await closeHandoff(user, appliedPath, handoff, Boolean(args.commit_sha), today);
    return `Applied again: ${appliedPath}${commitRef}${notes}${handoffNote}`;
  }

  await githubPut(user.github_token, user.github_repo, appliedPath, content, `apply: ${filename}${commitRef}`);
  await githubDelete(user.github_token, user.github_repo, inboxPath, file.sha, `apply: remove ${filename} from inbox`);
  await updateIndexEntry(user.github_token, user.github_repo, filename, "apply");
  const ledgerNote = (await recordInLedger()) + (await recordEvent());
  if (handoff) await closeHandoff(user, appliedPath, handoff, Boolean(args.commit_sha), today);

  // Trigger re-synthesis for the capture's tags (best-effort)
  if (user.llm_api_key) {
    try {
      const tagsMatch = content.match(/^tags:\s*(.+)$/m);
      if (tagsMatch?.[1]) {
        const tags = tagsMatch[1].split(",").map((t) => t.trim()).filter(Boolean);
        const indexFile = await readFile(user.github_token, user.github_repo, "INDEX.md");
        if (indexFile && tags.length > 0) {
          // Re-synthesize the first tag (limit API calls)
          await synthesizeTopic(user.llm_api_key, user.github_token, user.github_repo, tags[0]!, indexFile.content, llmSettings(user));
        }
      }
    } catch {
      // Re-synthesis is best-effort
    }
  }

  return `Applied: ${filename} → ${appliedPath}${commitRef}${ledgerNote}${handoffNote}`;
}

/** The apply metric: captures applied per week, and how many came with a commit. */
export async function handleApplyStats(user: User, args: { weeks?: number }): Promise<string> {
  if (!user.github_repo) return "Knowledge repo not configured.";
  const weeks = Math.min(Math.max(Math.trunc(args.weeks ?? 4), 1), 52);
  const ledger = await readFile(user.github_token, user.github_repo, LEDGER_PATH);
  if (!ledger) return `No captures applied yet. Each apply_capture call adds a row to ${LEDGER_PATH}.`;

  const today = new Date().toISOString().slice(0, 10);
  const stats = weeklyApplyStats(ledger.content, today, weeks);
  const applied = stats.reduce((n, w) => n + w.applied, 0);
  const withCommit = stats.reduce((n, w) => n + w.withCommit, 0);
  const lines = stats.map((w) => `- Week of ${w.weekStart}: ${w.applied} applied, ${w.withCommit} with a commit`);
  return `Captures applied, last ${weeks} week${weeks === 1 ? "" : "s"} (weeks start on Monday):\n${lines.join("\n")}\n\nTotal: ${applied} applied, ${withCommit} with a commit.`;
}

export async function handleArchiveCapture(user: User, args: { filename: string }): Promise<string> {
  if (!user.github_repo) return "Knowledge repo not configured.";
  const inboxPath = `inbox/${args.filename}`;
  const file = await readFile(user.github_token, user.github_repo, inboxPath);
  if (!file) return `File not found: ${inboxPath}. It may have already been processed.`;

  const content = file.content.replace(/^status:\s*inbox$/m, "status: archived");

  await githubPut(user.github_token, user.github_repo, `archived/${args.filename}`, content, `archive: ${args.filename}`);
  await githubDelete(user.github_token, user.github_repo, inboxPath, file.sha, `archive: remove ${args.filename} from inbox`);
  await updateIndexEntry(user.github_token, user.github_repo, args.filename, "archive");

  return `Archived: ${args.filename} → archived/${args.filename}`;
}

export async function handleDeleteCapture(user: User, args: { filename: string }): Promise<string> {
  if (!user.github_repo) return "Knowledge repo not configured.";
  const inboxPath = `inbox/${args.filename}`;
  const file = await readFile(user.github_token, user.github_repo, inboxPath);
  if (!file) return `File not found: ${inboxPath}. It may have already been deleted.`;

  await githubDelete(user.github_token, user.github_repo, inboxPath, file.sha, `delete: ${args.filename}`);
  await updateIndexEntry(user.github_token, user.github_repo, args.filename, "delete");

  return `Deleted: ${args.filename}`;
}

export async function handleRecall(user: User, args: { context: string; max_results?: number }): Promise<string> {
  if (!user.github_repo) return "Knowledge repo not configured.";
  if (!user.llm_api_key) return "API key not configured.";

  const existing = await readFile(user.github_token, user.github_repo, "INDEX.md");
  if (!existing) return "No captures yet. Use the capture tool to build your knowledge base.";

  const maxResults = Math.min(args.max_results ?? 5, 10);
  const ranked = await rankByRelevance(user.llm_api_key, args.context, existing.content, maxResults, llmSettings(user));

  if (ranked.length === 0) return `No relevant captures found for: "${args.context}"`;

  // Read top captures in parallel
  const captures = await Promise.all(
    ranked.map(async (r) => {
      const file = await readFile(user.github_token, user.github_repo!, r.filename);
      if (!file) return null;

      // Extract core idea and takeaways for a compact summary
      const coreMatch = file.content.match(/## Core idea\n([\s\S]*?)(?=\n##)/);
      const takeawaysMatch = file.content.match(/## Key takeaways\n([\s\S]*?)(?=\n##)/);
      const coreIdea = coreMatch?.[1]?.trim() ?? "";
      const takeaways = takeawaysMatch?.[1]?.trim() ?? "";

      return `### ${r.filename} (relevance: ${Math.round(r.score * 100)}%)\n**Why relevant:** ${r.reason}\n**Core idea:** ${coreIdea}\n**Takeaways:**\n${takeaways}`;
    }),
  );

  const validCaptures = captures.filter((c): c is string => c !== null);
  await recordSurfaceEvents(user.id, ranked.filter((_, i) => captures[i] !== null).map((r) => r.filename), "recall");
  return `Found ${validCaptures.length} relevant capture(s) for: "${args.context}"\n\n${validCaptures.join("\n\n---\n\n")}`;
}

export async function handleSynthesize(user: User, args: { tag: string }): Promise<string> {
  if (!user.github_repo) return "Knowledge repo not configured.";
  if (!user.llm_api_key) return "API key not configured.";

  const existing = await readFile(user.github_token, user.github_repo, "INDEX.md");
  if (!existing) return "No captures yet.";

  const result = await synthesizeTopic(user.llm_api_key, user.github_token, user.github_repo, args.tag, existing.content, llmSettings(user));

  if (result.rules.length === 0) {
    return `No captures found matching tag "${args.tag}". Use search_captures to find available tags.`;
  }

  return `Synthesized ${result.rules.length} rule(s) for "${result.topic}" and updated RULES.md:\n\n${result.rules.map((r, i) => `${i + 1}. ${r}`).join("\n")}`;
}

export async function handleGetRules(user: User, args: { tag?: string }): Promise<string> {
  if (!user.github_repo) return "Knowledge repo not configured.";

  const file = await readFile(user.github_token, user.github_repo, "RULES.md");
  if (!file) return "No rules generated yet. Use the synthesize tool to create rules from your captures.";

  if (!args.tag) return file.content;

  // Extract the section for the requested tag
  const sectionRegex = new RegExp(
    `## ${args.tag}[^\n]*\n((?:- [^\n]+\n?)*)`,
    "im",
  );
  const match = file.content.match(sectionRegex);
  if (!match) return `No rules found for "${args.tag}". Available topics are listed in RULES.md.`;

  return `## ${args.tag}\n${match[1]}`;
}

export async function handleBriefing(user: User, args: { project_context?: string; include_rules?: boolean; repo?: string }): Promise<string> {
  if (!user.github_repo) return "Knowledge repo not configured.";

  // Captures waiting for this repo come first. With only a repo (a session-start
  // hook), that offer is all: no ranking, so no LLM call and no wait.
  const repo = typeof args.repo === "string" ? repoName(args.repo) : null;
  const offer = repo ? await handoffOffer(user, repo) : null;
  if (!args.project_context?.trim()) return offer ?? (repo ? `No captures are waiting for ${repo}.` : "Describe the project in project_context, or pass repo.");
  const withOffer = (text: string) => (offer ? `${offer}\n\n${text}` : text);

  if (!user.llm_api_key) return withOffer("API key not configured.");

  const existing = await readFile(user.github_token, user.github_repo, "INDEX.md");
  if (!existing) return withOffer("No captures yet. Build your knowledge base with the capture tool first.");

  // 1. Rank captures against the project (the only LLM call: xkg can't see the code,
  //    so the agent decides where each candidate applies)
  const ranked = await rankByRelevance(user.llm_api_key, args.project_context, existing.content, 5, llmSettings(user));

  // 2. Read the candidates in parallel, skipping any that can no longer be read
  const candidates = await Promise.all(
    selectRanked(ranked, existing.content).map(async (r) => {
      const file = await readFile(user.github_token, user.github_repo!, r.filename);
      return file ? briefingCandidate(r.filename, r.score, r.reason, file.content) : null;
    }),
  );

  // 3. Read rules (if requested)
  let rules = "";
  if (args.include_rules !== false) {
    const rulesFile = await readFile(user.github_token, user.github_repo, "RULES.md");
    rules = rulesFile?.content ?? "";
  }

  const shown = candidates.filter((c): c is BriefingCandidate => c !== null);
  await recordSurfaceEvents(user.id, shown.map((c) => c.filename), "briefing");
  return withOffer(formatBriefing(shown, rules));
}

export async function handleApplyToContext(user: User, args: { task: string; stack?: string; files?: string[]; code_snippet?: string }): Promise<string> {
  if (!user.github_repo) return "Knowledge repo not configured.";
  if (!user.llm_api_key) return "API key not configured.";

  const existing = await readFile(user.github_token, user.github_repo, "INDEX.md");
  if (!existing) return "No captures yet.";

  // Build a rich task context from all provided info
  const contextParts = [`Task: ${args.task}`];
  if (args.stack) contextParts.push(`Stack: ${args.stack}`);
  if (args.files?.length) contextParts.push(`Files: ${args.files.join(", ")}`);
  if (args.code_snippet) contextParts.push(`Code:\n\`\`\`\n${args.code_snippet}\n\`\`\``);
  const taskContext = contextParts.join("\n");

  // Find relevant captures
  const ranked = await rankByRelevance(user.llm_api_key, taskContext, existing.content, 7, llmSettings(user));
  if (ranked.length === 0) return `No relevant captures found for this task context.`;

  // Read capture contents
  const contents = await Promise.all(
    ranked.map(async (r) => {
      const file = await readFile(user.github_token, user.github_repo!, r.filename);
      return file ? { filename: r.filename, content: file.content } : null;
    }),
  );
  const validContents = contents.filter((c): c is { filename: string; content: string } => c !== null);

  if (validContents.length === 0) return "Could not read relevant captures.";

  // Generate application suggestions; the filename lets the agent apply_capture the one it used
  const suggestions = await generateApplicationSuggestions(
    user.llm_api_key,
    taskContext,
    validContents.map((c) => `File: ${c.filename}\n${c.content}`),
    llmSettings(user),
  );
  const considered = validContents.map((c) => `\`${c.filename}\``).join(", ");
  return `${suggestions}\n\n---\nCaptures considered: ${considered}\n${APPLY_HINT}`;
}

export async function handleGeneratePlan(
  user: User,
  args: { selected_captures: string[]; project_context: string; codebase_files?: unknown[] },
): Promise<string> {
  if (!user.github_repo) return "Knowledge repo not configured.";
  if (!user.llm_api_key) return "API key not configured.";
  if (!args.selected_captures.length) return "No captures selected.";

  // Read selected captures in full
  const captureResults = await Promise.all(
    args.selected_captures.map(async (path) => {
      const normalised = path.includes("/") ? path : `inbox/${path}`;
      const file = await readFile(user.github_token, user.github_repo!, normalised);
      return file ? { filename: normalised, content: file.content } : null;
    }),
  );
  const selectedCaptures = captureResults.filter(
    (c): c is { filename: string; content: string } => c !== null,
  );

  if (selectedCaptures.length === 0) return "None of the specified captures could be found.";

  // xkg never reads code (github_repo is the knowledge repo, where code paths
  // don't exist). Only the paths the agent names reach the plan; anything that
  // isn't a short one-line path, such as pasted code, is dropped.
  const codebasePaths = (Array.isArray(args.codebase_files) ? args.codebase_files : [])
    .filter((p): p is string => typeof p === "string" && p.length > 0 && p.length <= 512 && !/[\r\n]/.test(p))
    .slice(0, 5);

  const planText = await generatePlan(
    user.llm_api_key,
    selectedCaptures,
    args.project_context,
    codebasePaths.length > 0 ? codebasePaths : undefined,
    llmSettings(user),
  );

  // Save plan to plans/ folder in knowledge repo
  const date = formatDate();
  const firstSlug = (args.selected_captures[0] ?? "plan")
    .split("/").pop()
    ?.replace(/\.md$/, "")
    .replace(/^\d{4}-\d{2}-\d{2}-/, "") ?? "plan";
  const planFilename = `${date}-plan-${firstSlug}.md`;

  try {
    await githubPut(user.github_token, user.github_repo, `plans/${planFilename}`, planText, `plan: ${planFilename}`);
  } catch {
    // Plan save is best-effort — return the plan text regardless
  }

  return `${planText}\n\n---\nPlan saved to \`plans/${planFilename}\`\n\nTo implement it in an isolated worktree with your own AI worker, run:\n\n    xkg agent --plan ${planFilename}\n\n(First time? Set your worker once: \`xkg config set agent "claude -p"\` — or "codex exec", "aider --yes --message", etc. Omit --plan to run the most recent plan. Older CLI versions call it \`xkg kos\`.)`;
}

export async function handleListPlans(
  user: User,
  args: { filename?: string },
): Promise<string> {
  if (!user.github_repo) return "Knowledge repo not configured.";

  if (args.filename) {
    const planPath = args.filename.includes("/") ? args.filename : `plans/${args.filename}`;
    const file = await readFile(user.github_token, user.github_repo, planPath);
    if (!file) return `Plan not found: ${planPath}`;
    return file.content;
  }

  const res = await githubGet<Array<{ name: string }>>(user.github_token, user.github_repo, "plans");
  if (!res.ok || !res.data) return "No plans saved yet. Use generate_plan to create one.";
  const mdFiles = res.data.filter((f) => f.name.endsWith(".md"));
  if (mdFiles.length === 0) return "No plans saved yet. Use generate_plan to create one.";

  const summaries = await Promise.all(
    mdFiles.slice(0, 20).map(async (f) => {
      const file = await readFile(user.github_token, user.github_repo!, `plans/${f.name}`);
      if (!file) return `- ${f.name}`;
      const titleMatch = file.content.match(/^# (.+)$/m);
      const title = titleMatch?.[1] ?? f.name;
      return `- **${f.name}**: ${title}`;
    }),
  );

  return `${mdFiles.length} plan(s):\n\n${summaries.join("\n")}`;
}

export async function handleVaultScan(
  user: User,
  args: { activity_context: string; session_surfaced?: string[] },
): Promise<string> {
  if (!user.github_repo) return "";
  if (!user.llm_api_key) return "";

  const existing = await readFile(user.github_token, user.github_repo, "INDEX.md");
  if (!existing) return "";

  // Search all captures — INDEX.md covers inbox, applied, and archived
  const ranked = await rankByRelevance(user.llm_api_key, args.activity_context, existing.content, 3, llmSettings(user));

  // Filter: score >= 0.7 and not already surfaced this session
  const surfaced = new Set(args.session_surfaced ?? []);
  const matches = ranked.filter((r) => r.score >= 0.7 && !surfaced.has(r.filename));

  if (matches.length === 0) return "";

  // Surface the top match only — vault is ambient, not a flood
  const topMatch = matches[0]!;
  const file = await readFile(user.github_token, user.github_repo, topMatch.filename);
  if (!file) return "";

  const coreMatch = file.content.match(/## Core idea\n([\s\S]*?)(?=\n##)/);
  const takeawaysMatch = file.content.match(/## Key takeaways\n([\s\S]*?)(?=\n##)/);
  const coreIdea = coreMatch?.[1]?.trim() ?? "";
  const firstTakeaway = takeawaysMatch?.[1]?.split("\n").find((l) => l.startsWith("- ")) ?? "";
  const basename = topMatch.filename.split("/").pop() ?? topMatch.filename;
  await recordSurfaceEvents(user.id, [topMatch.filename], "vault");

  return `xkg vault match (score: ${Math.round(topMatch.score * 100)}%):

**${basename.replace(/\.md$/, "")}**
${coreIdea}
${firstTakeaway}

If you apply it, filename: \`${basename}\`. ${APPLY_HINT}`;
}

export async function handleCurate(
  user: User,
  args: { filename?: string; auto_archive?: boolean; since?: string; until?: string; offset?: number; limit?: number },
): Promise<string> {
  if (!user.github_repo) return "Knowledge repo not configured.";

  // Liveness check for a capture's source URL. The `url:` frontmatter is
  // attacker-influenced (it comes from LLM extraction of user-supplied
  // content), and the returned status is echoed back to the caller — so an
  // unguarded fetch here is an SSRF with a status oracle. Reuse the same
  // redirect-validating guard the capture path uses.
  async function checkUrl(url: string): Promise<number | null> {
    const res = await safeFetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });
    return res?.status ?? null;
  }

  async function curateFile(
    filename: string,
  ): Promise<{ filename: string; status: string; httpStatus: number | null; reason: string; archived: boolean }> {
    const path = `inbox/${filename}`;
    const file = await readFile(user.github_token, user.github_repo!, path);
    if (!file) return { filename, status: "not_found", httpStatus: null, reason: "File not found in inbox.", archived: false };

    const fmMatch = file.content.match(/^---\n([\s\S]*?)\n---/);
    const fm = fmMatch?.[1] ?? "";
    const urlField = fm.match(/^url:\s*(.+)$/m)?.[1]?.trim() ?? "";
    const url = urlField && urlField !== "none" ? urlField : null;
    const isLowConfidence = /^lowConfidence:\s*true$/m.test(fm);

    const httpStatus = url ? await checkUrl(url) : null;
    const { status, reason } = curateSingle(httpStatus, isLowConfidence);

    let archived = false;
    if (args.auto_archive && status !== "ok") {
      try {
        await handleArchiveCapture(user, { filename });
        archived = true;
      } catch {
        // archive best-effort
      }
    }

    return { filename, status, httpStatus, reason, archived };
  }

  if (args.filename) {
    const result = await curateFile(args.filename);
    const archivedNote = result.archived ? " (auto-archived)" : "";
    return `Curation: ${result.filename}\nStatus: ${result.status}${archivedNote}\nURL status: ${result.httpStatus ?? "no URL"}\nReason: ${result.reason}`;
  }

  // Scan the inbox, one page at a time (deterministic, date-sorted order).
  const res = await githubGet<Array<{ name: string }>>(user.github_token, user.github_repo, "inbox");
  if (!res.ok || !res.data) return "Inbox is empty.";
  const allMd = res.data.filter((f) => f.name.endsWith(".md")).sort((a, b) => a.name.localeCompare(b.name));
  if (allMd.length === 0) return "Inbox is empty.";

  const filtered = filterByDateRange(allMd, args.since, args.until);
  if (filtered.length === 0) {
    return `No captures in inbox match the given date range (${allMd.length} total in inbox).`;
  }

  const page = paginate(filtered, args.offset ?? 0, args.limit ?? 20);
  const results = await Promise.all(page.items.map((f) => curateFile(f.name)));

  const rows = results.map((r) => {
    const action = r.archived ? "archived" : r.status !== "ok" ? "flagged" : "—";
    return `| ${r.filename} | ${r.status} | ${r.httpStatus ?? "—"} | ${action} |`;
  });

  const staleCount = results.filter((r) => r.status === "stale" || r.status === "stale_and_low_confidence").length;
  const lcCount = results.filter((r) => r.status === "low_confidence" || r.status === "stale_and_low_confidence").length;
  const okCount = results.filter((r) => r.status === "ok").length;

  return `Curation report — ${results.length} file(s) checked\n\n| File | Status | URL Status | Action |\n|------|--------|------------|--------|\n${rows.join("\n")}\n\n${staleCount} stale, ${lcCount} low-confidence, ${okCount} ok.${pageFooter(page, "curate")}`;
}


// ── Dispatch registry ──

/**
 * A handler receives arguments straight off the JSON-RPC wire, so `args` is
 * unknown at this boundary and each handler asserts the shape its schema
 * declares. That mirrors what the previous switch did with a per-case cast;
 * it is not validation, and remains the natural place to add it.
 */
/** Request details a handler may use; today only the agent's name, for apply counts. */
export type ToolContext = { harness?: string };

export type ToolHandler = (user: User, args: never, ctx: ToolContext) => Promise<string>;

export const HANDLERS: Record<ToolName, ToolHandler> = {
  capture: handleCapture as ToolHandler,
  list_inbox: handleListInbox as ToolHandler,
  search_captures: handleSearch as ToolHandler,
  read_capture: handleReadCapture as ToolHandler,
  apply_capture: handleApplyCapture as ToolHandler,
  apply_stats: handleApplyStats as ToolHandler,
  archive_capture: handleArchiveCapture as ToolHandler,
  delete_capture: handleDeleteCapture as ToolHandler,
  recall: handleRecall as ToolHandler,
  synthesize: handleSynthesize as ToolHandler,
  get_rules: handleGetRules as ToolHandler,
  briefing: handleBriefing as ToolHandler,
  apply_to_context: handleApplyToContext as ToolHandler,
  generate_plan: handleGeneratePlan as ToolHandler,
  list_plans: handleListPlans as ToolHandler,
  vault_scan: handleVaultScan as ToolHandler,
  curate: handleCurate as ToolHandler,
};
