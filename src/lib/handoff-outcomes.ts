/**
 * What the user answered to "Apply this now?", through apply_capture's
 * `outcome`. No new tool, and no argument carries spec text, code or a diff:
 * the spec stays in the code repo.
 *
 *   applied (or no outcome) ──> the apply as before (handlers.ts) + row applied + log line
 *   declined / done / later ──> row status + log line   (no move, no APPLIED.md row, no apply_events)
 *   reverted ──> APPLIED.md row marked + log line       (the row stays applied)
 *
 * Every answer goes to the capture's `## Handoff log` and to handoff_events,
 * and xkg learns from the log (handoff-learning.ts).
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
import { learnFrom } from "./handoff-learning";
import { addDays, appendHandoffLog, captureName, handoffFor, handoffLogLine, isWaiting, readHandoffs, setHandoffStatus, type HandoffRow } from "./handoffs";

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

/** How closing a handoff went: closed (by this call or another report), left as is (the row became dead), or not written. */
export type Closed = { closed: true } | { closed: false; status: string; failed: boolean };

/**
 * Marks the handoff applied, and counts it only when this call set the row,
 * so a retry after a failed write counts it once. When the row changed since
 * it was read (a snooze or an answer landed meanwhile), it's read again and
 * closed from there: an apply wins over anything but dead. Then learns from
 * `content`, the capture as just written with the apply's log line. Best-effort.
 */
export async function closeHandoff(
  user: ApplyUser, path: string, content: string, handoff: AppliedHandoff, withCommit: boolean, today: string,
): Promise<Closed> {
  const closed = await setApplied(user, path, handoff, withCommit, today);
  await learnFrom(user, path, content, today);
  return closed;
}

async function setApplied(user: ApplyUser, path: string, handoff: AppliedHandoff, withCommit: boolean, today: string): Promise<Closed> {
  let row = handoff.row;
  for (let attempt = 0; attempt < 2; attempt++) {
    const set = await setHandoffStatus(user.github_token, user.github_repo!, [row], "applied", today);
    if (!set) return { closed: false, status: row.status, failed: true };
    if (set.length) {
      await recordHandoffEvent(user.id, path, handoff.repo, "applied", { ...(handoff.confidence ? { confidence: handoff.confidence } : {}), withCommit });
      return { closed: true };
    }
    const now = await readHandoffs(user.github_token, user.github_repo!).then((rows) => handoffFor(rows, path, handoff.repo)).catch(() => null);
    if (!now || now.status === "applied") return { closed: true };
    if (now.status === "dead") return { closed: false, status: now.status, failed: false };
    row = now;
  }
  return { closed: false, status: row.status, failed: true };
}

/** What the reply says about the handoff an apply closed. */
export function closedNote(handoff: AppliedHandoff | null, result: Closed | null): string {
  if (!handoff || !result) return "";
  if (result.closed) return `. The handoff in ${handoff.repo} is done.`;
  return result.failed
    ? `. HANDOFFS.md couldn't be updated, so its row for ${handoff.repo} still says ${result.status}.`
    : `. Its row for ${handoff.repo} in HANDOFFS.md says ${result.status}, so it was left as is.`;
}

/** The date this commit's revert was logged in the capture's Handoff log, or null. */
export function revertedOn(content: string, commit: string): string | null {
  const sha = commit.toLowerCase();
  for (const m of content.matchAll(/^- (\d{4}-\d{2}-\d{2}) · .*?reverted · commit ([0-9a-f]+)/gim)) {
    const logged = m[2]!.toLowerCase();
    if (logged.startsWith(sha) || sha.startsWith(logged)) return m[1]!;
  }
  return null;
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

  const today = formatDate();
  const until = addDays(today, SNOOZE_DAYS);
  const status = { declined: "declined", done: "done", later: `snoozed:${until}`, reverted: null }[outcome];
  const rows = await readHandoffs(token, knowledge);
  // A repeat of an answer whose log line failed finds the row it already set today
  const row = handoffFor(rows, filename, asked) ?? (asked || !status ? null : answeredToday(rows, filename, status, today));
  const repo = asked ?? row?.repo.toLowerCase() ?? null;
  if (!repo && outcome !== "reverted") return "Pass repo (owner/name of the code repo) so xkg knows which handoff this answers. Nothing was recorded.";

  const short = args.commit_sha?.slice(0, 7);
  const ledgerNote = (marked: boolean) => (marked ? "" : ", but APPLIED.md couldn't be updated. Report it again to fix that");
  // A repeat report also repairs an APPLIED.md mark that failed the first time
  if (outcome === "reverted" && revertLogged(file.content, args.commit_sha!)) {
    return `Already recorded: the revert of ${filename} (${short})${ledgerNote(await markLedgerReverted(token, knowledge, filename, args.commit_sha!, today))}.`;
  }

  // HANDOFFS.md first: when it can't be written nothing is recorded, so the
  // agent can simply try again. Only a waiting row takes the answer, and only
  // if it's still as read: an applied or dead row stays as it is.
  const set = row && status && isWaiting(row.status) ? await setHandoffStatus(token, knowledge, [row], status, today) : [];
  if (!set) return "Nothing was recorded: HANDOFFS.md couldn't be updated. Try again in a moment.";

  const reason = outcome === "declined" ? reasonOf(args.reason) : undefined;
  const confidence = confidenceOf(args.confidence);
  const changed = repo ? await mappedFiles(user.id, repo, args.files) : [];
  // A wrong-files decline names the files it turned down: what xkg suggested
  const files = reason === "wrong-files" && !changed.length && row ? row.files : changed;
  const commit = outcome === "reverted" ? args.commit_sha : undefined;
  const line = handoffLogLine({ date: today, repo, outcome, reason, confidence, commit, files });
  const logged = await logAnswer(token, knowledge, path, file, line, `handoff: ${outcome} ${filename}`);
  if (!logged) {
    if (!set.length) return "Nothing was recorded: the capture's Handoff log couldn't be written. Try again in a moment.";
    const now = { declined: "was declined", done: "was already done", later: `is snoozed until ${until}` }[outcome as Exclude<Outcome, "applied" | "reverted">];
    return `HANDOFFS.md says ${filename} ${now} in ${repo}, but its Handoff log couldn't be written. Report the same answer again to finish recording it.`;
  }
  const marked = outcome === "reverted" ? await markLedgerReverted(token, knowledge, filename, args.commit_sha!, today) : true;
  // Counted once: a repeated answer finds its line already in the log
  if (repo && logged.added) await recordHandoffEvent(user.id, path, repo, outcome, { ...(reason ? { reason } : {}), ...(confidence ? { confidence } : {}) });
  await learnFrom(user, path, logged.content, today);

  if (outcome === "reverted") return `Recorded: the apply of ${filename} in commit ${short} was reverted${ledgerNote(marked)}.`;
  if (outcome === "later" && (set.length || row?.status === status)) return `Snoozed: ${filename} in ${repo} until ${until}. It doesn't count as an apply.`;
  const said = {
    declined: `${filename} declined in ${repo} (${reason})`,
    done: `${filename} was already done in ${repo}`,
    later: `not now for ${filename} in ${repo}`,
  }[outcome];
  return `Recorded: ${said}. It doesn't count as an apply.`;
}

/** The capture's only row set to `status` today: an answer whose log line still has to be written. */
function answeredToday(rows: HandoffRow[], filename: string, status: string, today: string): HandoffRow | null {
  const mine = rows.filter((r) => captureName(r.capture) === captureName(filename) && r.status === status && r.since === today);
  return mine.length === 1 ? mine[0]! : null;
}

/**
 * Adds `line` to the capture's Handoff log, retrying once from a fresh read.
 * Returns the capture as it now is, and whether the line was added (false: the
 * log already had it, a repeated answer); null when it couldn't be written.
 */
async function logAnswer(
  token: string, knowledge: string, path: string, first: { content: string; sha: string }, line: string, message: string,
): Promise<{ content: string; added: boolean } | null> {
  let file: { content: string; sha: string } | null = first;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (attempt) file = await readFile(token, knowledge, path);
      if (!file) return null;
      if (file.content.split("\n").includes(line)) return { content: file.content, added: false };
      const content = appendHandoffLog(file.content, line);
      await githubPut(token, knowledge, path, content, message, file.sha);
      return { content, added: true };
    } catch (err) {
      if (attempt === 1) console.error("[handoff] log write failed:", err instanceof Error ? err.message : err);
    }
  }
  return null;
}

/**
 * Marks the apply reverted in APPLIED.md, retrying once from a fresh read.
 * True when marked, or there's nothing to mark (already marked, or no row).
 */
async function markLedgerReverted(token: string, knowledge: string, filename: string, commit: string, today: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ledger = await readFile(token, knowledge, LEDGER_PATH);
      const marked = ledger && markReverted(ledger.content, filename, commit, today);
      if (marked) await githubPut(token, knowledge, LEDGER_PATH, marked, `ledger: ${filename} reverted (${commit.slice(0, 7)})`, ledger.sha);
      return true;
    } catch (err) {
      if (attempt === 1) console.error("[handoff] ledger revert failed:", err instanceof Error ? err.message : err);
    }
  }
  return false;
}

/** True when the capture's Handoff log already has this commit's revert (short and full shas match). */
const revertLogged = (content: string, commit: string) => revertedOn(content, commit) !== null;
