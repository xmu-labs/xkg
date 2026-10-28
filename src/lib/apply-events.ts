/**
 * apply_events: the server's count of applied captures.
 *
 * APPLIED.md in the user's repo stays the record of what was applied and why.
 * This table only counts, so the apply metric can be read for every user
 * without reading anyone's repo. A row holds a keyed hash of the capture (its
 * filename is built from its title, so a plain hash could be reversed by
 * guessing titles), the first 7 characters of the commit, the agent that
 * reported it and whether a reason was given.
 *
 *   apply_capture ──> recordApplyEvent ──> apply_events ──> applyGateStats ──> admin route
 */

import crypto from "crypto";
import { sql } from "./sql";
import { env } from "./env";
import { weekStart } from "./ledger";

const HARNESS_MAX = 64;

/** Keyed hash of a capture, the same whether it is addressed in inbox/, applied/ or bare. */
export function captureKey(filename: string): string {
  const name = filename.replace(/^(inbox|applied)\//, "");
  // Domain-separated from other HMAC uses of the same secret.
  return crypto.createHmac("sha256", env.sessionSecret).update(`apply-capture:${name}`).digest("hex").slice(0, 32);
}

/** First 7 characters of a sha, so an agent's short sha and the hook's full one match. */
export function commitKey(sha: string | undefined): string | null {
  return sha ? sha.slice(0, 7).toLowerCase() : null;
}

export type ApplyEvent = { userId: number; filename: string; commit?: string; harness: string; hasWhy: boolean };

/** Counts one application. The same capture and commit is counted once. */
export async function recordApplyEvent(event: ApplyEvent): Promise<void> {
  await sql`
    INSERT INTO apply_events (user_id, capture_key, commit7, harness, has_why)
    VALUES (${event.userId}, ${captureKey(event.filename)}, ${commitKey(event.commit)}, ${event.harness.slice(0, HARNESS_MAX)}, ${event.hasWhy})
    ON CONFLICT DO NOTHING
  `;
}

export type GateWeek = {
  userId: number;
  weekStart: string;
  captures: number;
  capturesWithCommit: number;
  capturesWithWhy: number;
  harnesses: Record<string, number>;
};

type EventRow = { user_id: number; capture_key: string; commit7: string | null; harness: string; has_why: boolean; applied_at: string | Date };

/** Distinct captures applied per user and Monday-start week, for the last `weeks` weeks up to `today`. */
export async function applyGateStats(today: string, weeks: number): Promise<GateWeek[]> {
  const from = new Date(`${weekStart(today)}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - 7 * (weeks - 1));
  const { rows } = await sql<EventRow>`
    SELECT user_id, capture_key, commit7, harness, has_why, applied_at
    FROM apply_events
    WHERE applied_at >= ${from.toISOString().slice(0, 10)}
  `;

  const groups = new Map<string, { userId: number; weekStart: string; all: Set<string>; commit: Set<string>; why: Set<string>; harness: Map<string, Set<string>> }>();
  for (const row of rows) {
    const week = weekStart(new Date(row.applied_at).toISOString().slice(0, 10));
    const id = `${row.user_id}|${week}`;
    let g = groups.get(id);
    if (!g) {
      g = { userId: row.user_id, weekStart: week, all: new Set(), commit: new Set(), why: new Set(), harness: new Map() };
      groups.set(id, g);
    }
    g.all.add(row.capture_key);
    if (row.commit7) g.commit.add(row.capture_key);
    if (row.has_why) g.why.add(row.capture_key);
    if (!g.harness.has(row.harness)) g.harness.set(row.harness, new Set());
    g.harness.get(row.harness)!.add(row.capture_key);
  }

  return [...groups.values()]
    .sort((a, b) => a.userId - b.userId || b.weekStart.localeCompare(a.weekStart))
    .map((g) => ({
      userId: g.userId,
      weekStart: g.weekStart,
      captures: g.all.size,
      capturesWithCommit: g.commit.size,
      capturesWithWhy: g.why.size,
      harnesses: Object.fromEntries([...g.harness].map(([h, s]) => [h, s.size])),
    }));
}
