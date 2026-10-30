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

/** A path in a ", " list: "%" and "," are written as %25 and %2C, so a path with ", " stays one path. */
export const encodePath = (path: string) => path.replace(/%/g, "%25").replace(/,/g, "%2C");
export const decodePath = (path: string) => path.replace(/%(25|2C)/gi, (_, code: string) => (code === "25" ? "%" : ","));

/** The same capture whether it sits in inbox/ or applied/. */
export const captureName = (path: string) => path.replace(/^(inbox|applied|archived)\//, "");

function rowOf(cells: string[]): HandoffRow | null {
  const [capture, repo, kind, files, fit, status, since, source] = cells;
  if (!capture?.endsWith(".md") || !repo || kind !== "code" || !status || !since) return null;
  return {
    capture,
    repo,
    kind,
    files: !files || files === EMPTY ? [] : files.split(", ").map(decodePath),
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
    .map((r) => `| ${[r.capture, r.repo, r.kind, r.files.map(encodePath).join(", "), r.fit, r.status, r.since, r.source].map((v) => cell(v)).join(" | ")} |\n`)
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

/**
 * Applies `change` to HANDOFFS.md and writes it with the file's sha. A failed
 * write (another commit got there first) is retried once from a fresh read;
 * after that it gives up and returns null, so the caller never fails because
 * of the queue.
 */
async function updateHandoffs<T>(
  token: string,
  repo: string,
  message: string,
  change: (rows: HandoffRow[]) => { rows: HandoffRow[]; changed: boolean; result: T },
): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await readFile(token, repo, HANDOFFS_PATH);
      const parsed = file ? parseHandoffs(file.content) : { head: INTRO, rows: [], other: [], tail: "" };
      const { rows, changed, result } = change(parsed.rows);
      if (changed) await githubPut(token, repo, HANDOFFS_PATH, renderHandoffs(rows, parsed), message, file?.sha);
      return result;
    } catch (err) {
      if (attempt === 1) console.error("[handoffs] write failed:", err instanceof Error ? err.message : err);
    }
  }
  return null;
}

/** Writes the row to HANDOFFS.md (see upsertHandoff). Null when it couldn't be written. */
export function queueHandoff(token: string, repo: string, row: HandoffRow): Promise<{ row: HandoffRow; changed: boolean } | null> {
  return updateHandoffs(token, repo, `handoff: queue ${captureName(row.capture)} for ${row.repo}`, (rows) => {
    const result = upsertHandoff(rows, row);
    return { rows: result.rows, changed: result.changed, result: { row: result.row, changed: result.changed } };
  });
}

const samePair = (a: Pick<HandoffRow, "capture" | "repo">, b: Pick<HandoffRow, "capture" | "repo">) =>
  a.repo.toLowerCase() === b.repo.toLowerCase() && captureName(a.capture) === captureName(b.capture);

/**
 * Sets the status of these rows, each only if it's still as it was read (same
 * status and date), so a change the user or another call made meanwhile is
 * kept. A dead row stays dead. True when written (or nothing to change).
 */
export async function setHandoffStatus(token: string, repo: string, read: HandoffRow[], status: string): Promise<boolean> {
  const done = await updateHandoffs(token, repo, `handoff: mark ${read.length} ${status}`, (rows) => {
    let changed = false;
    const next = rows.map((r) => {
      const unchanged = read.some((p) => samePair(p, r) && p.status === r.status && p.since === r.since);
      if (!unchanged || r.status === status || r.status === "dead") return r;
      changed = true;
      return { ...r, status };
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
