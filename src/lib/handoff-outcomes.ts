/**
 * What the user answered to "Apply this now?", through apply_capture's
 * `outcome`. No new tool, and no argument carries spec text, code or a diff:
 * the spec stays in the code repo.
 *
 *   applied (or no outcome) ──> the apply as before (handlers.ts) + row applied + log line
 *   declined / done / later ──> row status + log line   (no move, no APPLIED.md row, no apply_events)
 *   reverted ──> APPLIED.md row marked + log line       (the row stays applied)
 *
 * Every answer goes to the capture's `## Handoff log` and to handoff_events.
 * Any other outcome text is an older client describing an apply, and records
 * one as before.
 */

import type { User } from "./db";
import { codeMapPaths } from "./db";
import { githubPut, readFile } from "./github";
import { formatDate } from "./llm";
import { repoName } from "./code-repos";
import { LEDGER_PATH, markReverted } from "./ledger";
import { recordHandoffEvent } from "./handoff-events";
import { addDays, appendHandoffLog, handoffFor, handoffLogLine, isWaiting, readHandoffs, setHandoffStatus, type HandoffRow } from "./handoffs";

export const OUTCOMES = ["applied", "declined", "done", "later", "reverted"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const DECLINE_REASONS = ["wrong-files", "doesnt-fit", "other"] as const;
export const CONFIDENCE = ["high", "medium", "low"] as const;
/** Days "later" waits before the capture is offered again. */
export const SNOOZE_DAYS = 7;
/** Changed files kept per answer. */
const MAX_FILES = 20;

/** The answer `outcome` names, or null for free text (an older client's description of an apply). */
export function outcomeOf(value: unknown): Outcome | null {
  return OUTCOMES.find((o) => o === normal(value)) ?? null;
}

// Arguments arrive as the agent sent them, whatever the schema says
const normal = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : undefined);
const confidenceOf = (v: unknown) => CONFIDENCE.find((c) => c === normal(v));
const reasonOf = (v: unknown) => DECLINE_REASONS.find((r) => r === normal(v)) ?? "other";
const repoOf = (v: unknown) => (typeof v === "string" ? repoName(v) : null);

/** The paths the agent named that are in the repo's current map. None when xkg has no map for it. */
async function mappedFiles(userId: number, repo: string, files: unknown): Promise<string[]> {
  if (!Array.isArray(files) || !files.length) return [];
  const paths = await codeMapPaths(userId, repo).catch(() => null);
  if (!paths) return [];
  return [...new Set(files.filter((f): f is string => typeof f === "string" && paths.has(f)))].slice(0, MAX_FILES);
}

export interface AnswerArgs {
  filename: string;
  outcome?: string;
  repo?: string;
  reason?: string;
  confidence?: string;
  files?: string[];
  commit_sha?: string;
}

type ApplyUser = Pick<User, "id" | "github_token" | "github_repo">;

/** The handoff an apply closes, and the line it adds to the capture's Handoff log. */
export interface AppliedHandoff {
  row: HandoffRow;
  repo: string;
  confidence?: string;
  line: string;
}

/**
 * The handoff this apply closes: the capture's row for `repo`, or with no
 * repo its only waiting row. Null when there's none, or it's already applied
 * or dead. Never throws: an apply never fails because of the queue.
 */
export async function appliedHandoff(user: ApplyUser, filename: string, args: AnswerArgs, today: string): Promise<AppliedHandoff | null> {
  try {
    if (!user.github_repo) return null;
    const asked = args.repo ? repoOf(args.repo) : null;
    const row = handoffFor(await readHandoffs(user.github_token, user.github_repo), filename, asked);
    if (!row || row.status === "applied" || row.status === "dead") return null;
    const repo = row.repo.toLowerCase();
    const confidence = confidenceOf(args.confidence);
    const files = await mappedFiles(user.id, repo, args.files);
    return { row, repo, confidence, line: handoffLogLine({ date: today, repo, outcome: "applied", commit: args.commit_sha, confidence, files }) };
  } catch (err) {
    console.error("[handoff] apply lookup failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Marks the handoff applied and counts it. Best-effort: false when HANDOFFS.md couldn't be written. */
export async function closeHandoff(user: ApplyUser, path: string, handoff: AppliedHandoff, withCommit: boolean, today: string): Promise<boolean> {
  const saved = await setHandoffStatus(user.github_token, user.github_repo!, [handoff.row], "applied", today);
  await recordHandoffEvent(user.id, path, handoff.repo, "applied", { ...(handoff.confidence ? { confidence: handoff.confidence } : {}), withCommit });
  return saved;
}

/** What the reply says about the handoff an apply closed. */
export function closedNote(handoff: AppliedHandoff | null, saved: boolean): string {
  if (!handoff) return "";
  return saved
    ? `. The handoff in ${handoff.repo} is done.`
    : `. HANDOFFS.md couldn't be updated, so its row for ${handoff.repo} still says ${handoff.row.status}.`;
}

/**
 * Records declined, done, later or reverted. The capture stays where it is,
 * and nothing counts as an apply.
 */
export async function recordAnswer(user: ApplyUser, args: AnswerArgs & { outcome: Exclude<Outcome, "applied"> }): Promise<string> {
  const { outcome } = args;
  const token = user.github_token;
  const knowledge = user.github_repo!;
  const filename = args.filename.replace(/^(?:inbox|applied)\//, "");
  if (outcome === "reverted" && !args.commit_sha) return "outcome reverted needs commit_sha: the sha of the commit that was reverted.";
  const asked = args.repo ? repoOf(args.repo) : null;
  if (args.repo && !asked) return `repo must be owner/name, got: ${String(args.repo)}`;

  let path = `inbox/${filename}`;
  let file = await readFile(token, knowledge, path);
  if (!file) {
    path = `applied/${filename}`;
    file = await readFile(token, knowledge, path);
  }
  if (!file) return `File not found: inbox/${filename} or applied/${filename}. Use list_inbox to see available captures.`;

  const row = handoffFor(await readHandoffs(token, knowledge), filename, asked);
  const repo = asked ?? row?.repo.toLowerCase() ?? null;
  if (!repo && outcome !== "reverted") return "Pass repo (owner/name of the code repo) so xkg knows which handoff this answers. Nothing was recorded.";

  const today = formatDate();
  const short = args.commit_sha?.slice(0, 7);
  if (outcome === "reverted" && revertLogged(file.content, args.commit_sha!)) return `Already recorded: the revert of ${filename} (${short}).`;

  const reason = outcome === "declined" ? reasonOf(args.reason) : undefined;
  const confidence = confidenceOf(args.confidence);
  const files = repo ? await mappedFiles(user.id, repo, args.files) : [];
  const commit = outcome === "reverted" ? args.commit_sha : undefined;
  const line = handoffLogLine({ date: today, repo, outcome, reason, confidence, commit, files });
  await githubPut(token, knowledge, path, appendHandoffLog(file.content, line), `handoff: ${outcome} ${filename}`, file.sha);

  if (outcome === "reverted") {
    const ledger = await readFile(token, knowledge, LEDGER_PATH);
    const marked = ledger && markReverted(ledger.content, filename, args.commit_sha!, today);
    if (marked) await githubPut(token, knowledge, LEDGER_PATH, marked, `ledger: ${filename} reverted (${short})`, ledger.sha).catch(() => undefined);
  }

  // Only a waiting row takes the answer: an applied or dead row stays as it is
  const until = addDays(today, SNOOZE_DAYS);
  const status = { declined: "declined", done: "done", later: `snoozed:${until}`, reverted: null }[outcome];
  const saved = row && status && isWaiting(row.status) ? await setHandoffStatus(token, knowledge, [row], status, today) : null;
  if (repo) await recordHandoffEvent(user.id, path, repo, outcome, { ...(reason ? { reason } : {}), ...(confidence ? { confidence } : {}) });

  if (outcome === "reverted") return `Recorded: the apply of ${filename} in commit ${short} was reverted.`;
  const said = {
    declined: `${filename} declined in ${repo} (${reason})`,
    done: `${filename} was already done in ${repo}`,
    later: `not now for ${filename} in ${repo}`,
  }[outcome];
  if (saved === false) {
    return `Recorded: ${said}, but HANDOFFS.md couldn't be updated, so it may be offered again${outcome === "later" ? ` before ${until}` : ""}. It doesn't count as an apply.`;
  }
  if (outcome === "later" && saved) return `Snoozed: ${filename} in ${repo} until ${until}. It doesn't count as an apply.`;
  return `Recorded: ${said}. It doesn't count as an apply.`;
}

/** True when the capture's Handoff log already has this commit's revert (short and full shas match). */
function revertLogged(content: string, commit: string): boolean {
  const sha = commit.toLowerCase();
  return [...content.matchAll(/^- .*· reverted · commit ([0-9a-f]+)/gim)].some((m) => {
    const logged = m[1]!.toLowerCase();
    return logged.startsWith(sha) || sha.startsWith(logged);
  });
}
