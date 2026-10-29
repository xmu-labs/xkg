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
  /** Text after the table. */
  tail: string;
}

/** The same capture whether it sits in inbox/ or applied/. */
const captureName = (path: string) => path.replace(/^(inbox|applied|archived)\//, "");

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
  if (start < 0) return { head: content.trim() ? content.replace(/\n*$/, "\n\n") : INTRO, rows: [], tail: "" };
  let end = start + 1;
  while (end < lines.length && lines[end]!.trim().startsWith("|")) end++;
  const rows = lines
    .slice(start + 1, end)
    .map((l) => rowOf(splitRow(l.trim())))
    .filter((r): r is HandoffRow => r !== null);
  const head = lines.slice(0, start).join("\n");
  return { head: head ? `${head}\n` : "", rows, tail: lines.slice(end).join("\n") };
}

export function renderHandoffs(rows: HandoffRow[], around: Pick<HandoffFile, "head" | "tail"> = { head: INTRO, tail: "" }): string {
  const body = rows
    .map((r) => `| ${[r.capture, r.repo, r.kind, r.files.join(", "), r.fit, r.status, r.since, r.source].map((v) => cell(v)).join(" | ")} |\n`)
    .join("");
  return `${around.head}${TABLE_HEAD}${body}${around.tail}`;
}

const sameRow = (a: HandoffRow, b: HandoffRow) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Adds the row, or replaces the row for the same capture and repo, at the top
 * (newest first). A dead row stays dead: that pair is never offered again.
 */
export function upsertHandoff(rows: HandoffRow[], row: HandoffRow): { rows: HandoffRow[]; row: HandoffRow; changed: boolean } {
  const same = (r: HandoffRow) => r.repo === row.repo && captureName(r.capture) === captureName(row.capture);
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
 * Writes the row to HANDOFFS.md with the file's sha. A failed write (another
 * commit got there first) is retried once from a fresh read; after that it
 * gives up and returns null, so a capture never fails because of the queue.
 */
export async function queueHandoff(token: string, repo: string, row: HandoffRow): Promise<{ row: HandoffRow; changed: boolean } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await readFile(token, repo, HANDOFFS_PATH);
      const parsed = file ? parseHandoffs(file.content) : { head: INTRO, rows: [], tail: "" };
      const result = upsertHandoff(parsed.rows, row);
      if (!result.changed) return { row: result.row, changed: false };
      await githubPut(token, repo, HANDOFFS_PATH, renderHandoffs(result.rows, parsed), `handoff: queue ${captureName(row.capture)} for ${row.repo}`, file?.sha);
      return { row: result.row, changed: true };
    } catch (err) {
      if (attempt === 1) console.error("[handoffs] queue write failed:", err instanceof Error ? err.message : err);
    }
  }
  return null;
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
