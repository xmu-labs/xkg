/**
 * llm_spend: one row per model call xkg makes with a user's own key, so
 * Settings can show "this month" and warn before a budget runs out. A row
 * holds the provider, the model, the provider's own token counts and an
 * estimated cost (llm-prices.ts). Never the prompt or the answer.
 *
 * A request opts in with withSpendMeter(userId, ...) once it knows its user:
 * every callLlm inside it, including work that runs after the response, is
 * counted for that user.
 * Counting is best-effort: a failed insert never fails the call.
 *
 *   route ──withSpendMeter(user)──> … callLlm ──recordSpend──> llm_spend ──monthSpend──> /api/spend
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "./sql";
import { ensureSpendTable } from "./db";
import { estimateCostUsd } from "./llm-prices";
import type { LlmProvider } from "./providers";

const meter = new AsyncLocalStorage<{ userId: number }>();

/**
 * Runs fn with every model call inside it counted for this user, including
 * work fn starts that finishes later (the capture stream, next/server `after`
 * tasks), since those keep the context they were started in.
 */
export function withSpendMeter<T>(userId: number, fn: () => Promise<T>): Promise<T> {
  return meter.run({ userId }, fn);
}

/** Counts one call for the current request's user, if there is one. Never throws. */
export async function recordSpend(provider: LlmProvider, model: string, tokensIn: number, tokensOut: number): Promise<void> {
  const userId = meter.getStore()?.userId;
  if (userId === undefined) return;
  try {
    const cost = estimateCostUsd(provider, model, tokensIn, tokensOut);
    await ensureSpendTable();
    await sql`
      INSERT INTO llm_spend (user_id, provider, model, tokens_in, tokens_out, cost_usd)
      VALUES (${userId}, ${provider}, ${model}, ${tokensIn}, ${tokensOut}, ${cost})
    `;
  } catch (err) {
    console.error("[spend] record failed:", err instanceof Error ? err.message : err);
  }
}

export interface MonthSpend {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  /** Sum of the estimates; calls on a model with no price add nothing. */
  costUsd: number;
  /** Calls on a model with no price on file. */
  unpricedCalls: number;
}

/** This calendar month's calls with the user's key (UTC). */
export async function monthSpend(userId: number): Promise<MonthSpend> {
  await ensureSpendTable();
  const { rows } = await sql<{ calls: string; tokens_in: string | null; tokens_out: string | null; cost_usd: number | null; unpriced: string }>`
    SELECT COUNT(*) AS calls,
           SUM(tokens_in) AS tokens_in,
           SUM(tokens_out) AS tokens_out,
           SUM(cost_usd) AS cost_usd,
           COUNT(*) FILTER (WHERE cost_usd IS NULL) AS unpriced
    FROM llm_spend
    WHERE user_id = ${userId} AND created_at >= date_trunc('month', NOW())
  `;
  const r = rows[0];
  return {
    calls: Number(r?.calls ?? 0),
    tokensIn: Number(r?.tokens_in ?? 0),
    tokensOut: Number(r?.tokens_out ?? 0),
    costUsd: Number(r?.cost_usd ?? 0),
    unpricedCalls: Number(r?.unpriced ?? 0),
  };
}
