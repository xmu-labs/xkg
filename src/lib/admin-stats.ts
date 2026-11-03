import { applyGateStats, type GateWeek } from "./apply-events";
import { applySourceStats, matchingStats, type MatchingWeek, type SourceBuckets } from "./surface-events";
import { handoffStats, type HandoffWeek } from "./handoff-events";
import { setupFunnel, type SetupFunnel } from "./setup-steps";

/**
 * The operator's numbers, shared by GET /api/admin/apply-stats (curl, behind
 * ADMIN_SECRET) and the owner's /admin page: counts and dates only.
 */

export const DEFAULT_WEEKS = 4;
export const MAX_WEEKS = 52;
const NO_SOURCES: SourceBuckets = { cardOnly: 0, briefingOnly: 0, both: 0, other: 0, none: 0 };

export type AdminStats = {
  weeks: Array<GateWeek & { sources: SourceBuckets }>;
  matching: MatchingWeek[];
  handoffs: HandoffWeek[];
  setup: SetupFunnel;
};

/** The window in weeks from a query value: DEFAULT_WEEKS when it isn't a number, else kept in 1..MAX_WEEKS. */
export function weeksOf(value: string | null | undefined): number {
  const asked = Number.parseInt(value ?? "", 10);
  return Number.isFinite(asked) ? Math.min(Math.max(asked, 1), MAX_WEEKS) : DEFAULT_WEEKS;
}

export async function readStats(weeks: number): Promise<AdminStats> {
  const today = new Date().toISOString().slice(0, 10);
  const [gate, sources, matching, handoffs, setup] = await Promise.all([
    applyGateStats(today, weeks),
    applySourceStats(today, weeks),
    matchingStats(today, weeks),
    handoffStats(today, weeks),
    setupFunnel(today, weeks),
  ]);
  const sourcesOf = (userId: number, week: string) =>
    sources.find((s) => s.userId === userId && s.weekStart === week)?.sources ?? NO_SOURCES;
  return {
    weeks: gate.map((w) => ({ ...w, sources: sourcesOf(w.userId, w.weekStart) })),
    matching,
    handoffs,
    setup,
  };
}

export type StatsSummary = {
  applies: { captures: number; withCommit: number; withWhy: number; harnesses: Record<string, number> };
  /** Per engine: "jev" is xkg's TypeSafe matcher, "evidence" the user's own model (older rows have no scorer). */
  matching: Array<{ scorer: string; matches: number; suggestions: number }>;
  handoffs: { queued: number; offered: number; applied: number; declined: number; later: number; done: number; expired: number; reverted: number };
  /** Accounts with any apply, match or handoff in the window. */
  accounts: number;
  setup: SetupFunnel["reached"];
};

/** Every account and week in the window, added up. */
export function statsSummary(stats: AdminStats): StatsSummary {
  const harnesses: Record<string, number> = {};
  const applies = { captures: 0, withCommit: 0, withWhy: 0, harnesses };
  for (const w of stats.weeks) {
    applies.captures += w.captures;
    applies.withCommit += w.capturesWithCommit;
    applies.withWhy += w.capturesWithWhy;
    for (const [h, n] of Object.entries(w.harnesses)) harnesses[h] = (harnesses[h] ?? 0) + n;
  }

  const engines = new Map<string, { scorer: string; matches: number; suggestions: number }>();
  for (const m of stats.matching) {
    const scorer = m.scorer ?? "evidence";
    const e = engines.get(scorer) ?? { scorer, matches: 0, suggestions: 0 };
    e.matches += m.matches;
    e.suggestions += m.suggestions;
    engines.set(scorer, e);
  }

  const handoffs = { queued: 0, offered: 0, applied: 0, declined: 0, later: 0, done: 0, expired: 0, reverted: 0 };
  for (const { counts: c } of stats.handoffs) {
    handoffs.queued += c.queued.auto + c.queued.button;
    handoffs.offered += c.offered;
    handoffs.applied += c.applied;
    handoffs.declined += c.declined.wrongFiles + c.declined.doesntFit + c.declined.other;
    handoffs.later += c.later;
    handoffs.done += c.done;
    handoffs.expired += c.expired;
    handoffs.reverted += c.reverted;
  }

  const accounts = new Set([...stats.weeks, ...stats.matching, ...stats.handoffs].map((r) => r.userId)).size;
  return { applies, matching: [...engines.values()], handoffs, accounts, setup: stats.setup.reached };
}
