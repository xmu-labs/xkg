/**
 * APPLIED.md — one Markdown table row per time a capture was applied.
 *
 * It is the source for the apply metric: how many captures turned into code
 * each week, and how many of those came with a commit. A single file keeps
 * the metric to one GitHub read instead of one per applied capture.
 */

export const LEDGER_PATH = "APPLIED.md";

export type LedgerEntry = { date: string; capture: string; commit?: string; target?: string };
export type WeekStats = { weekStart: string; applied: number; withCommit: number };

const HEADER =
  "# Applied captures\n\nOne row per application. Written by xkg's apply_capture.\n\n" +
  "| Date | Capture | Commit | Target |\n| --- | --- | --- | --- |\n";
const EMPTY = "—";

/** One Markdown table cell: a dash when empty, newlines flattened, pipes and backslashes escaped. */
export function cell(value: string | undefined): string {
  if (!value) return EMPTY;
  return value.replace(/\s*\n\s*/g, " ").replace(/[\\|]/g, "\\$&");
}

export function appendLedgerRow(existing: string | null, entry: LedgerEntry): string {
  const base = existing ? existing.replace(/\n*$/, "\n") : HEADER;
  return `${base}| ${entry.date} | ${cell(entry.capture)} | ${cell(entry.commit)} | ${cell(entry.target)} |\n`;
}

/** Monday of the week containing `date` (YYYY-MM-DD, UTC). */
export function weekStart(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Applications and commits for the last `weeks` Monday-start weeks up to `today`, newest first. */
export function weeklyApplyStats(content: string, today: string, weeks: number): WeekStats[] {
  const stats: WeekStats[] = [];
  const byWeek = new Map<string, WeekStats>();
  const cursor = new Date(`${weekStart(today)}T00:00:00Z`);
  for (let i = 0; i < weeks; i++) {
    const week = { weekStart: cursor.toISOString().slice(0, 10), applied: 0, withCommit: 0 };
    stats.push(week);
    byWeek.set(week.weekStart, week);
    cursor.setUTCDate(cursor.getUTCDate() - 7);
  }

  for (const row of parseRows(content)) {
    const week = byWeek.get(weekStart(row.date));
    if (!week) continue;
    week.applied++;
    if (row.commit !== EMPTY) week.withCommit++;
  }
  return stats;
}

/** Data rows of the ledger table; the header and separator rows have no date and are skipped. */
function parseRows(content: string): Array<{ date: string; capture: string; commit: string }> {
  const rows = [];
  for (const line of content.split("\n")) {
    const cells = splitRow(line.trim());
    if (cells.length < 3 || !/^\d{4}-\d{2}-\d{2}$/.test(cells[0]!)) continue;
    rows.push({ date: cells[0]!, capture: cells[1]!, commit: cells[2]! });
  }
  return rows;
}

/** Splits `| a | b\\|c |` into unescaped, trimmed cells. */
export function splitRow(line: string): string[] {
  if (!line.startsWith("|")) return [];
  const cells: string[] = [];
  let current = "";
  for (let i = 1; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "\\" && i + 1 < line.length) current += line[++i];
    else if (ch === "|") { cells.push(current.trim()); current = ""; }
    else current += ch;
  }
  return cells;
}

/** True when the ledger already has a row for this capture and commit (short and full shas match). */
export function ledgerHasCommit(content: string, capture: string, commit: string): boolean {
  const sha = commit.toLowerCase();
  return parseRows(content).some((r) => {
    const rowSha = r.commit.toLowerCase();
    return r.capture === capture && r.commit !== EMPTY && (rowSha.startsWith(sha) || sha.startsWith(rowSha));
  });
}

/**
 * Marks the capture's rows for this commit as reverted on `date`, in the
 * Target cell; the row still counts as an application. Null when no row
 * matches or it's already marked.
 */
export function markReverted(content: string, capture: string, commit: string, date: string): string | null {
  const sha = commit.toLowerCase();
  let changed = false;
  const lines = content.split("\n").map((line) => {
    const cells = splitRow(line.trim());
    if (cells.length < 4 || !/^\d{4}-\d{2}-\d{2}$/.test(cells[0]!) || cells[1] !== capture) return line;
    const rowSha = cells[2]!.toLowerCase();
    if (cells[2] === EMPTY || !(rowSha.startsWith(sha) || sha.startsWith(rowSha)) || /\breverted \d{4}-/.test(cells[3]!)) return line;
    changed = true;
    const target = cells[3] === EMPTY ? `reverted ${date}` : `${cells[3]} · reverted ${date}`;
    return `| ${cells[0]} | ${cell(cells[1])} | ${cell(cells[2])} | ${cell(target)} |`;
  });
  return changed ? lines.join("\n") : null;
}
