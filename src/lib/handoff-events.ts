/**
 * handoff_events: what happens to each handoff, for the apply metric. Like
 * apply_events, a row holds a keyed hash of the capture, never its name;
 * HANDOFFS.md in the user's repo stays the record. Writes are best-effort.
 */

import { sql } from "./sql";
import { ensureHandoffEventTable } from "./db";
import { captureKey } from "./apply-events";

export type HandoffEvent = "queued" | "offered" | "applied" | "declined" | "later" | "done" | "reverted" | "expired";

export async function recordHandoffEvent(
  userId: number,
  filename: string,
  repo: string,
  event: HandoffEvent,
  detail: { source?: "auto" | "button"; reason?: string; confidence?: string } = {},
): Promise<void> {
  try {
    await ensureHandoffEventTable();
    await sql`
      INSERT INTO handoff_events (user_id, capture_key, repo, event, source, reason, confidence)
      VALUES (${userId}, ${captureKey(filename)}, ${repo}, ${event}, ${detail.source ?? null}, ${detail.reason ?? null}, ${detail.confidence ?? null})
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
