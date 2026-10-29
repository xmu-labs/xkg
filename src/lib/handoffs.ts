/**
 * HANDOFFS.md: captures waiting for the user's coding agent, one row per
 * capture and repo, in the knowledge repo next to APPLIED.md. Git stays the
 * source of truth; handoff_events only counts.
 *
 *   capture (Strong fit) ──┐
 *   card button ───────────┴──> queueHandoff ──> HANDOFFS.md
 *
 * The user can edit the file: text around the table is kept on every write.
 */

import { readFile, githubPut } from "./github";
import { cell, splitRow } from "./ledger";
import { recordHandoffEvent } from "./handoff-events";
import type { WhereResult } from "./where";

export const HANDOFFS_PATH = "HANDOFFS.md";

/**
 * `status`: pending · snoozed:YYYY-MM-DD · applied · declined · done · expired · dead.
 * Kept as written, so a status the user typed survives a write.
 */
export interface HandoffRow {
  capture: string;
  repo: string;
  kind: "code";
  files: string[];
  fit: string;
  status: string;
  since: string;
  source: "auto" | "button";
}

const COLUMNS = ["capture", "repo", "kind", "files", "fit", "status", "since", "source"];
const TABLE_HEAD = `| ${COLUMNS.join(" | ")} |\n|${"---|".repeat(COLUMNS.length)}\n`;
const INTRO = "# Handoffs\n\nCaptures waiting for your coding agent. xkg updates this file; you can edit it.\n\n";
const EMPTY = "—";

export interface HandoffFile {
  /** Text before the table (the intro, or what the user wrote there). */
  head: string;
  rows: HandoffRow[];
  /** Table lines xkg can't read (a row the user typed, a kind from a later version), kept as written. */
  other: string[];
  /** Text after the table. */
  tail: string;
}

/** The same capture whether it sits in inbox/ or applied/. */
export const captureName = (path: string) => path.replace(/^(inbox|applied|archived)\//, "");

function rowOf(cells: string[]): HandoffRow | null {
  const [capture, repo, kind, files, fit, status, since, source] = cells;
  if (!capture?.endsWith(".md") || !repo || kind !== "code" || !status || !since) return null;
  return {
    capture,
    repo,
    kind,
    files: !files || files === EMPTY ? [] : files.split(", "),
    fit: fit ?? "none",
    status,
    since,
    source: source === "auto" ? "auto" : "button",
  };
}

export function parseHandoffs(content: string): HandoffFile {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => /^\|\s*capture\s*\|\s*repo\s*\|/.test(l.trim()));
  // No table (the user removed it): keep their text and start a new table below it.
  if (start < 0) return { head: content.trim() ? content.replace(/\n*$/, "\n\n") : INTRO, rows: [], other: [], tail: "" };
  let end = start + 1;
  while (end < lines.length && lines[end]!.trim().startsWith("|")) end++;
  const rows: HandoffRow[] = [];
  const other: string[] = [];
  for (const line of lines.slice(start + 1, end)) {
    const row = rowOf(splitRow(line.trim()));
    if (row) rows.push(row);
    else if (!/^\|[\s|:-]*$/.test(line.trim())) other.push(line);
  }
  const head = lines.slice(0, start).join("\n");
  return { head: head ? `${head}\n` : "", rows, other, tail: lines.slice(end).join("\n") };
}

export function renderHandoffs(rows: HandoffRow[], around: Omit<HandoffFile, "rows"> = { head: INTRO, other: [], tail: "" }): string {
  const body = rows
    .map((r) => `| ${[r.capture, r.repo, r.kind, r.files.join(", "), r.fit, r.status, r.since, r.source].map((v) => cell(v)).join(" | ")} |\n`)
    .join("");
  const other = around.other.map((l) => `${l}\n`).join("");
  return `${around.head}${TABLE_HEAD}${body}${other}${around.tail}`;
}

const sameRow = (a: HandoffRow, b: HandoffRow) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Adds the row, or replaces the row for the same capture and repo, at the top
 * (newest first). A dead row stays dead: that pair is never offered again.
 */
export function upsertHandoff(rows: HandoffRow[], row: HandoffRow): { rows: HandoffRow[]; row: HandoffRow; changed: boolean } {
  const same = (r: HandoffRow) => r.repo.toLowerCase() === row.repo.toLowerCase() && captureName(r.capture) === captureName(row.capture);
  const existing = rows.find(same);
  if (existing?.status === "dead") return { rows, row: existing, changed: false };
  if (existing && sameRow(existing, row)) return { rows, row: existing, changed: false };
  return { rows: [row, ...rows.filter((r) => !same(r))], row, changed: true };
}

/** The row a capture queues on its own: a Strong fit with at least one file. */
export function autoHandoff(capturePath: string, where: WhereResult, today: string): HandoffRow | null {
  if (where.tier !== "strong" || !where.repo || !where.files.length) return null;
  return {
    capture: capturePath,
    repo: where.repo,
    kind: "code",
    files: where.files.map((f) => f.path),
    fit: where.tier,
    status: "pending",
    since: today,
    source: "auto",
  };
}

/** `date` (YYYY-MM-DD) plus `days`, which may be negative. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const FINISHED = new Set(["applied", "declined", "done", "expired"]);
/** Days a finished row stays in HANDOFFS.md after its last change. Its history stays in the capture's Handoff log. */
export const KEEP_FINISHED_DAYS = 90;

/** Leaves out finished rows whose last change is more than KEEP_FINISHED_DAYS old. Waiting and dead rows stay. */
export function pruneFinished(rows: HandoffRow[], today: string): HandoffRow[] {
  const cutoff = addDays(today, -KEEP_FINISHED_DAYS);
  return rows.filter((r) => !(FINISHED.has(r.status) && r.since < cutoff));
}

/**
 * Applies `change` to HANDOFFS.md and writes it with the file's sha, dropping
 * old finished rows on the way. A failed write (another commit got there
 * first) is retried once from a fresh read; after that it gives up and returns
 * null, so the caller never fails because of the queue.
 */
async function updateHandoffs<T>(
  token: string,
  repo: string,
  message: string,
  today: string,
  change: (rows: HandoffRow[]) => { rows: HandoffRow[]; changed: boolean; result: T },
): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await readFile(token, repo, HANDOFFS_PATH);
      const parsed = file ? parseHandoffs(file.content) : { head: INTRO, rows: [], other: [], tail: "" };
      const { rows, changed, result } = change(parsed.rows);
      if (changed) await githubPut(token, repo, HANDOFFS_PATH, renderHandoffs(pruneFinished(rows, today), parsed), message, file?.sha);
      return result;
    } catch (err) {
      if (attempt === 1) console.error("[handoffs] write failed:", err instanceof Error ? err.message : err);
    }
  }
  return null;
}

/** Writes the row to HANDOFFS.md (see upsertHandoff). Null when it couldn't be written. */
export function queueHandoff(token: string, repo: string, row: HandoffRow): Promise<{ row: HandoffRow; changed: boolean } | null> {
  return updateHandoffs(token, repo, `handoff: queue ${captureName(row.capture)} for ${row.repo}`, row.since, (rows) => {
    const result = upsertHandoff(rows, row);
    return { rows: result.rows, changed: result.changed, result: { row: result.row, changed: result.changed } };
  });
}

const samePair = (a: Pick<HandoffRow, "capture" | "repo">, b: Pick<HandoffRow, "capture" | "repo">) =>
  a.repo.toLowerCase() === b.repo.toLowerCase() && captureName(a.capture) === captureName(b.capture);

/**
 * Sets the status of these capture and repo pairs, from `today` (the row's
 * `since`). A dead row stays dead. True when written (or nothing to change).
 */
export async function setHandoffStatus(
  token: string,
  repo: string,
  pairs: Pick<HandoffRow, "capture" | "repo">[],
  status: string,
  today: string,
): Promise<boolean> {
  const done = await updateHandoffs(token, repo, `handoff: mark ${pairs.length} ${status}`, today, (rows) => {
    let changed = false;
    const next = rows.map((r) => {
      if (!pairs.some((p) => samePair(p, r)) || r.status === status || r.status === "dead") return r;
      changed = true;
      return { ...r, status, since: today };
    });
    return { rows: next, changed, result: true };
  });
  return done === true;
}

/**
 * At capture: queues a Strong fit for the next coding session (written after
 * the capture's own section, never alongside it, so the two commits don't
 * race). Returns the repo it is waiting in, or null.
 */
export async function queueStrongFit(
  user: { id: number; github_token: string; github_repo: string | null },
  capturePath: string,
  where: WhereResult,
  today: string,
): Promise<string | null> {
  const row = autoHandoff(capturePath, where, today);
  if (!row || !user.github_repo) return null;
  const queued = await queueHandoff(user.github_token, user.github_repo, row);
  if (!queued || queued.row.status !== "pending") return null;
  if (queued.changed) await recordHandoffEvent(user.id, capturePath, row.repo, "queued", { source: "auto" });
  return row.repo;
}

/** The rows of HANDOFFS.md, or none when the file doesn't exist yet. */
export async function readHandoffs(token: string, repo: string): Promise<HandoffRow[]> {
  const file = await readFile(token, repo, HANDOFFS_PATH);
  return file ? parseHandoffs(file.content).rows : [];
}

const waiting = (status: string) => status === "pending" || status === "expired" || status.startsWith("snoozed:");

/**
 * The row an answer is about: the capture's row for `repo`, or, with no repo,
 * the capture's only waiting row (pending, snoozed or expired). Null when
 * there's none, or more than one to choose from.
 */
export function handoffFor(rows: HandoffRow[], capture: string, repo?: string | null): HandoffRow | null {
  const mine = rows.filter((r) => captureName(r.capture) === captureName(capture));
  if (repo) return mine.find((r) => r.repo.toLowerCase() === repo.toLowerCase()) ?? null;
  const open = mine.filter((r) => waiting(r.status));
  return open.length === 1 ? open[0]! : null;
}

/** One answer, as kept in the capture. No free text: learning is rebuilt from these lines. */
export interface HandoffLogEntry {
  date: string;
  repo?: string | null;
  outcome: string;
  reason?: string;
  confidence?: string;
  commit?: string;
  files?: string[];
}

export function handoffLogLine(e: HandoffLogEntry): string {
  const parts = [e.date, ...(e.repo ? [e.repo] : []), e.reason ? `${e.outcome} (${e.reason})` : e.outcome];
  if (e.commit) parts.push(`commit ${e.commit}`);
  if (e.confidence) parts.push(`confidence ${e.confidence}`);
  if (e.files?.length) parts.push(`files ${e.files.join(", ")}`);
  return `- ${parts.join(" · ")}`;
}

/** Adds `line` to the capture's `## Handoff log`, creating it before `## Links to memory` (or at the end). */
export function appendHandoffLog(content: string, line: string): string {
  const section = content.match(/## Handoff log\n[\s\S]*?(?=\n## |$)/);
  if (section) {
    const body = section[0].replace(/\n*$/, "");
    return content.replace(section[0], () => `${body}\n${line}${section[0].endsWith("\n") ? "\n" : ""}`);
  }
  if (content.includes("\n## Links to memory")) return content.replace("\n## Links to memory", () => `\n## Handoff log\n${line}\n\n## Links to memory`);
  return `${content.replace(/\n*$/, "\n")}\n## Handoff log\n${line}\n`;
}
