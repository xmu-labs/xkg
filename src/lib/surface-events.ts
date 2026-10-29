/**
 * surface_events: each time a channel shows the user a capture.
 *
 * Channels: the capture card's "Where it applies" match (`where`), a briefing,
 * recall, and the vault scan. Like apply_events, a row holds a keyed hash of
 * the capture, never its name. A `where` row also keeps the matching call's
 * tokens, the model's own confidence (logged for the scorer work, never
 * shown), the scorer and the tier. Writes are best-effort: a failed insert
 * never fails the tool that surfaced the capture.
 *
 *   capture card / briefing / recall / vault ──> surface_events ──┐
 *   apply_capture ──> apply_events ───────────────────────────────┴──> applySourceStats ──> admin route
 */

import { sql } from "./sql";
import { ensureSurfaceEventTable } from "./db";
import { captureKey } from "./apply-events";
import { weekStart } from "./ledger";
import type { WhereResult } from "./where";

export type SurfaceChannel = "briefing" | "recall" | "vault";

/** Records that `channel` showed these captures (each counted once per call). */
export async function recordSurfaceEvents(userId: number, filenames: string[], channel: SurfaceChannel): Promise<void> {
  if (!filenames.length) return;
  try {
    const keys = [...new Set(filenames.map(captureKey))];
    await ensureSurfaceEventTable();
    await sql`
      INSERT INTO surface_events (user_id, capture_key, channel)
      SELECT ${userId}, k, ${channel} FROM unnest(${keys}::text[]) AS k
    `;
  } catch (err) {
    console.error(`[surface] ${channel} event failed:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Records a "Where it applies" match, when its model call was made. `shown`:
 * whether the user saw it (on the card, or in the tool result once the
 * section was written); only a shown fit earns the card credit.
 */
export async function recordWhereEvent(userId: number, filename: string, where: WhereResult, shown: boolean): Promise<void> {
  if (!where.tokens) return;
  try {
    await ensureSurfaceEventTable();
    await sql`
      INSERT INTO surface_events (user_id, capture_key, channel, tokens_in, tokens_out, model_conf, scorer, tier, shown)
      VALUES (${userId}, ${captureKey(filename)}, 'where', ${where.tokens.in}, ${where.tokens.out}, ${where.modelConf}, ${where.scorer}, ${where.tier}, ${shown})
    `;
  } catch (err) {
    console.error("[surface] where event failed:", err instanceof Error ? err.message : err);
  }
}

export type SourceBuckets = { cardOnly: number; briefingOnly: number; both: number; other: number; none: number };
export type SourceWeek = { userId: number; weekStart: string; sources: SourceBuckets };

function windowStart(today: string, weeks: number): string {
  const from = new Date(`${weekStart(today)}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - 7 * (weeks - 1));
  return from.toISOString().slice(0, 10);
}

type SourceRow = { user_id: number; capture_key: string; applied_at: string | Date; card: boolean | null; briefing: boolean | null; other: boolean | null };

/**
 * Captures applied per user and week, split by what showed them before the
 * apply: the card (a Strong or Possible fit), a briefing, both, another
 * channel only, or nothing. No credit beyond that.
 */
export async function applySourceStats(today: string, weeks: number): Promise<SourceWeek[]> {
  await ensureSurfaceEventTable();
  const { rows } = await sql<SourceRow>`
    SELECT a.user_id, a.capture_key, a.applied_at,
      bool_or(s.channel = 'where' AND s.shown AND s.tier IN ('strong', 'possible')) AS card,
      bool_or(s.channel = 'briefing') AS briefing,
      bool_or(s.channel IN ('recall', 'vault')) AS other
    FROM apply_events a
    LEFT JOIN surface_events s
      ON s.user_id = a.user_id AND s.capture_key = a.capture_key AND s.surfaced_at <= a.applied_at
    WHERE a.applied_at >= ${windowStart(today, weeks)}
    GROUP BY a.id, a.user_id, a.capture_key, a.applied_at
  `;

  // A capture applied more than once in a week counts once, with every channel that showed it.
  const groups = new Map<string, { userId: number; weekStart: string; captures: Map<string, { card: boolean; briefing: boolean; other: boolean }> }>();
  for (const row of rows) {
    const week = weekStart(new Date(row.applied_at).toISOString().slice(0, 10));
    const id = `${row.user_id}|${week}`;
    let g = groups.get(id);
    if (!g) {
      g = { userId: row.user_id, weekStart: week, captures: new Map() };
      groups.set(id, g);
    }
    const seen = g.captures.get(row.capture_key) ?? { card: false, briefing: false, other: false };
    g.captures.set(row.capture_key, { card: seen.card || Boolean(row.card), briefing: seen.briefing || Boolean(row.briefing), other: seen.other || Boolean(row.other) });
  }

  return [...groups.values()]
    .sort((a, b) => a.userId - b.userId || b.weekStart.localeCompare(a.weekStart))
    .map((g) => {
      const sources: SourceBuckets = { cardOnly: 0, briefingOnly: 0, both: 0, other: 0, none: 0 };
      for (const c of g.captures.values()) {
        if (c.card && c.briefing) sources.both++;
        else if (c.card) sources.cardOnly++;
        else if (c.briefing) sources.briefingOnly++;
        else if (c.other) sources.other++;
        else sources.none++;
      }
      return { userId: g.userId, weekStart: g.weekStart, sources };
    });
}

export type MatchingWeek = { userId: number; weekStart: string; matches: number; suggestions: number; medianTokens: number | null };

type MatchRow = { user_id: number; tier: string | null; tokens_in: number | null; tokens_out: number | null; surfaced_at: string | Date };

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/**
 * "Where it applies" matches per user and week: how many ran, how many showed
 * a fit, and the median tokens (in + out) of the calls that reported a count.
 */
export async function matchingStats(today: string, weeks: number): Promise<MatchingWeek[]> {
  await ensureSurfaceEventTable();
  const { rows } = await sql<MatchRow>`
    SELECT user_id, tier, tokens_in, tokens_out, surfaced_at
    FROM surface_events
    WHERE channel = 'where' AND surfaced_at >= ${windowStart(today, weeks)}
  `;

  const groups = new Map<string, { userId: number; weekStart: string; matches: number; suggestions: number; tokens: number[] }>();
  for (const row of rows) {
    const week = weekStart(new Date(row.surfaced_at).toISOString().slice(0, 10));
    const id = `${row.user_id}|${week}`;
    let g = groups.get(id);
    if (!g) {
      g = { userId: row.user_id, weekStart: week, matches: 0, suggestions: 0, tokens: [] };
      groups.set(id, g);
    }
    g.matches++;
    if (row.tier === "strong" || row.tier === "possible") g.suggestions++;
    if (row.tokens_in !== null && row.tokens_out !== null) g.tokens.push(row.tokens_in + row.tokens_out);
  }

  return [...groups.values()]
    .sort((a, b) => a.userId - b.userId || b.weekStart.localeCompare(a.weekStart))
    .map((g) => ({ userId: g.userId, weekStart: g.weekStart, matches: g.matches, suggestions: g.suggestions, medianTokens: median(g.tokens) }));
}
