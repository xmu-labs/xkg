/**
 * handoff_events: what happens to each handoff, for the apply metric. Like
 * apply_events, a row holds a keyed hash of the capture, never its name;
 * HANDOFFS.md in the user's repo stays the record. Writes are best-effort.
 */

import { sql } from "./sql";
import { ensureHandoffEventTable } from "./db";
import { captureKey } from "./apply-events";
import { weekStart } from "./ledger";
import { windowStart } from "./surface-events";

export type HandoffEvent = "queued" | "offered" | "applied" | "declined" | "later" | "done" | "reverted" | "expired";

/** `withCommit`: on an apply, whether it came with the commit that made it. */
export async function recordHandoffEvent(
  userId: number,
  filename: string,
  repo: string,
  event: HandoffEvent,
  detail: { source?: "auto" | "button"; reason?: string; confidence?: string; withCommit?: boolean } = {},
): Promise<void> {
  try {
    await ensureHandoffEventTable();
    await sql`
      INSERT INTO handoff_events (user_id, capture_key, repo, event, source, reason, confidence, with_commit)
      VALUES (${userId}, ${captureKey(filename)}, ${repo}, ${event}, ${detail.source ?? null}, ${detail.reason ?? null}, ${detail.confidence ?? null}, ${detail.withCommit ?? null})
    `;
  } catch (err) {
    console.error(`[handoff] ${event} event failed:`, err instanceof Error ? err.message : err);
  }
}

/** Records that a briefing offered these captures in this repo. */
export async function recordOffers(userId: number, repo: string, filenames: string[]): Promise<void> {
  if (!filenames.length) return;
  try {
    await ensureHandoffEventTable();
    await sql`
      INSERT INTO handoff_events (user_id, capture_key, repo, event)
      SELECT ${userId}, k, ${repo}, 'offered' FROM unnest(${filenames.map(captureKey)}::text[]) AS k
    `;
  } catch (err) {
    console.error("[handoff] offered event failed:", err instanceof Error ? err.message : err);
  }
}

/** The days (YYYY-MM-DD) each capture was offered in this repo, by capture name. Empty when the database can't be read. */
export async function offerDays(userId: number, repo: string, filenames: string[]): Promise<Map<string, string[]>> {
  const names = new Map(filenames.map((f) => [captureKey(f), f.replace(/^(inbox|applied|archived)\//, "")]));
  const days = new Map<string, string[]>();
  if (!filenames.length) return days;
  try {
    await ensureHandoffEventTable();
    const { rows } = await sql<{ capture_key: string; day: string }>`
      SELECT capture_key, to_char(at, 'YYYY-MM-DD') AS day FROM handoff_events
      WHERE user_id = ${userId} AND repo = ${repo} AND event = 'offered' AND capture_key = ANY(${[...names.keys()]}::text[])
      GROUP BY capture_key, day ORDER BY day
    `;
    for (const r of rows) {
      const name = names.get(r.capture_key);
      if (name) days.set(name, [...(days.get(name) ?? []), r.day]);
    }
  } catch (err) {
    console.error("[handoff] offer days failed:", err instanceof Error ? err.message : err);
  }
  return days;
}

export type HandoffCounts = {
  queued: { auto: number; button: number };
  offered: number;
  applied: number;
  appliedWithCommit: number;
  declined: { wrongFiles: number; doesntFit: number; other: number };
  done: number;
  later: number;
  expired: number;
  reverted: number;
};
export type HandoffWeek = { userId: number; weekStart: string; counts: HandoffCounts };

type EventRow = { user_id: number; event: string; source: string | null; reason: string | null; with_commit: boolean | null; at: string | Date };

const noCounts = (): HandoffCounts => ({
  queued: { auto: 0, button: 0 }, offered: 0, applied: 0, appliedWithCommit: 0,
  declined: { wrongFiles: 0, doesntFit: 0, other: 0 }, done: 0, later: 0, expired: 0, reverted: 0,
});

/**
 * Handoffs per user and week: queued (by source), offered, and each answer.
 * An offer is one capture shown on one day.
 */
export async function handoffStats(today: string, weeks: number): Promise<HandoffWeek[]> {
  await ensureHandoffEventTable();
  const { rows } = await sql<EventRow>`
    SELECT user_id, event, source, reason, with_commit, at FROM handoff_events WHERE at >= ${windowStart(today, weeks)}
  `;

  const groups = new Map<string, HandoffWeek>();
  for (const row of rows) {
    const week = weekStart(new Date(row.at).toISOString().slice(0, 10));
    const id = `${row.user_id}|${week}`;
    let g = groups.get(id);
    if (!g) {
      g = { userId: row.user_id, weekStart: week, counts: noCounts() };
      groups.set(id, g);
    }
    const c = g.counts;
    if (row.event === "queued") c.queued[row.source === "auto" ? "auto" : "button"]++;
    else if (row.event === "declined") c.declined[row.reason === "wrong-files" ? "wrongFiles" : row.reason === "doesnt-fit" ? "doesntFit" : "other"]++;
    else if (row.event === "applied") {
      c.applied++;
      if (row.with_commit) c.appliedWithCommit++;
    } else if (row.event === "offered" || row.event === "done" || row.event === "later" || row.event === "expired" || row.event === "reverted") c[row.event]++;
  }
  return [...groups.values()].sort((a, b) => a.userId - b.userId || b.weekStart.localeCompare(a.weekStart));
}
