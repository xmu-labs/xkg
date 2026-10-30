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
