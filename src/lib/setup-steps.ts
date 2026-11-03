/**
 * setup_steps and the setup funnel: where each new account stops between
 * signing up and its first apply.
 *
 * Most steps are read from what the database already holds (the users row,
 * surface_events, apply_events). Two have no other trace, so they get one row
 * per user the first time they happen: the first saved capture, and the first
 * tool call from an agent or an xkg hook. A row holds the user id, the step
 * name and the date. Nothing about the capture or the agent.
 *
 *   capture / MCP tools/call ──recordSetupStep──> setup_steps ─┐
 *   users + surface_events + apply_events ─────────────────────┴─setupFunnel──> admin route
 */

import { sql } from "./sql";
import { ensureSetupStepTable, ensureSurfaceEventTable } from "./db";
import { weekStart } from "./ledger";

export type SetupStep = "capture" | "agent";

/** Pairs this instance has already written, so a busy agent doesn't write on every call. */
const recorded = new Set<string>();

/** For tests: forget which steps this instance recorded. */
export function forgetRecordedSteps(): void {
  recorded.clear();
}

/** Records the first time `step` happens for a user. Never throws: setup tracking must not break the call it rides on. */
export async function recordSetupStep(userId: number, step: SetupStep): Promise<void> {
  const id = `${userId}:${step}`;
  if (recorded.has(id)) return;
  try {
    await ensureSetupStepTable();
    await sql`INSERT INTO setup_steps (user_id, step) VALUES (${userId}, ${step}) ON CONFLICT (user_id, step) DO NOTHING`;
    recorded.add(id);
  } catch (err) {
    console.error(`[setup] ${step} step failed:`, err instanceof Error ? err.message : err);
  }
}

/** The steps in setup order. `stoppedBefore` names the first one an account has not reached. */
const ORDER = ["repo", "aiKey", "capture", "agent", "shown", "apply"] as const;
export type FunnelStep = (typeof ORDER)[number];

export type FunnelUser = {
  userId: number;
  signedUp: string;
  repo: boolean;
  aiKey: boolean;
  firstCapture: string | null;
  firstAgentCall: string | null;
  /** First time an agent was shown a capture (briefing, search, handoff offer); the web app's card doesn't count. */
  firstShown: string | null;
  firstApply: string | null;
  stoppedBefore: FunnelStep | null;
};

export type SetupFunnel = { users: FunnelUser[]; reached: Record<"signedUp" | FunnelStep, number> };

type FunnelRow = {
  user_id: number;
  created_at: string | Date;
  has_repo: boolean;
  has_ai_key: boolean;
  first_capture: string | Date | null;
  first_agent: string | Date | null;
  first_shown: string | Date | null;
  first_apply: string | Date | null;
};

const day = (v: string | Date | null): string | null => (v === null ? null : new Date(v).toISOString().slice(0, 10));

/** Accounts that signed up in the last `weeks` weeks (Monday-aligned, like the apply stats), with the date of each step. */
export async function setupFunnel(today: string, weeks: number): Promise<SetupFunnel> {
  await Promise.all([ensureSetupStepTable(), ensureSurfaceEventTable()]);
  const from = new Date(`${weekStart(today)}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - 7 * (weeks - 1));
  const { rows } = await sql<FunnelRow>`
    SELECT u.id AS user_id, u.created_at,
      (u.github_repo IS NOT NULL) AS has_repo,
      (u.llm_api_key IS NOT NULL) AS has_ai_key,
      (SELECT min(first_at) FROM setup_steps s WHERE s.user_id = u.id AND s.step = 'capture') AS first_capture,
      (SELECT min(first_at) FROM setup_steps s WHERE s.user_id = u.id AND s.step = 'agent') AS first_agent,
      (SELECT min(surfaced_at) FROM surface_events e WHERE e.user_id = u.id AND e.channel <> 'where') AS first_shown,
      (SELECT min(applied_at) FROM apply_events a WHERE a.user_id = u.id) AS first_apply
    FROM users u
    WHERE u.created_at >= ${from.toISOString().slice(0, 10)}
    ORDER BY u.id
  `;

  const reached: SetupFunnel["reached"] = { signedUp: 0, repo: 0, aiKey: 0, capture: 0, agent: 0, shown: 0, apply: 0 };
  const users = rows.map((r): FunnelUser => {
    const done: Record<FunnelStep, boolean> = {
      repo: Boolean(r.has_repo),
      aiKey: Boolean(r.has_ai_key),
      capture: r.first_capture !== null,
      agent: r.first_agent !== null,
      shown: r.first_shown !== null,
      apply: r.first_apply !== null,
    };
    reached.signedUp++;
    for (const step of ORDER) if (done[step]) reached[step]++;
    return {
      userId: r.user_id,
      signedUp: day(r.created_at)!,
      repo: done.repo,
      aiKey: done.aiKey,
      firstCapture: day(r.first_capture),
      firstAgentCall: day(r.first_agent),
      firstShown: day(r.first_shown),
      firstApply: day(r.first_apply),
      stoppedBefore: ORDER.find((step) => !done[step]) ?? null,
    };
  });
  return { users, reached };
}
