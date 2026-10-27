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

function cell(value: string | undefined): string {
  if (!value) return EMPTY;
  return value.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|");
}

export function appendLedgerRow(existing: string | null, entry: LedgerEntry): string {
  const base = existing ? existing.replace(/\n*$/, "\n") : HEADER;
  return `${base}| ${entry.date} | ${cell(entry.capture)} | ${cell(entry.commit)} | ${cell(entry.target)} |\n`;
}

/** Monday of the week containing `date` (YYYY-MM-DD, UTC). */
function weekStart(date: string): string {
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

  for (const line of content.split("\n")) {
    const row = line.match(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|(?:[^|\\]|\\.)*\|\s*([^|\s]+)\s*\|/);
    if (!row) continue;
    const week = byWeek.get(weekStart(row[1]!));
    if (!week) continue;
    week.applied++;
    if (row[2] !== EMPTY) week.withCommit++;
  }
  return stats;
}
