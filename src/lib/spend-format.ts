/**
 * The "this month" line in Settings → AI model. Client-safe: the drawer
 * bundles it. The dollar figure is an estimate (llm-prices.ts), so it says
 * "about", and calls on a model with no price are named, never priced at $0.
 */

export interface SpendSummary {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  unpricedCalls: number;
}

/** A dollar amount as Settings shows it: "about $0.41", or "under $0.01" for a tiny spend. */
export function money(usd: number): string {
  return usd > 0 && usd < 0.01 ? "under $0.01" : `about $${usd.toFixed(2)}`;
}

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function spendLine(s: SpendSummary): string {
  if (s.calls === 0) return "No calls with your key yet this month.";
  const head = `This month: ${plural(s.calls, "call")} with your key`;
  if (s.unpricedCalls >= s.calls) return `${head}, ${tokens(s.tokensIn + s.tokensOut)} tokens. No price on file for this model.`;
  const extra = s.unpricedCalls > 0 ? ` plus ${plural(s.unpricedCalls, "call")} on a model with no price on file` : "";
  return `${head}, ${money(s.costUsd)}${extra}.`;
}

/** Dispatch on window after anything that changes this month's spend or the budget, so the home banner re-reads it. */
export const SPEND_CHANGED_EVENT = "xkg:spend-changed";

export interface BudgetAlert {
  level: "near" | "over";
  text: string;
}

const dollars = (usd: number) => `$${usd.toFixed(2)}`;

/** The home page banner for a monthly budget: from 80% "near", from 100% "over". A warning only; captures keep working. */
export function budgetAlert(month: SpendSummary, budgetUsd: number | null): BudgetAlert | null {
  if (!budgetUsd || budgetUsd <= 0) return null;
  const share = month.costUsd / budgetUsd;
  if (share >= 1) {
    return {
      level: "over",
      text: `You've used your ${dollars(budgetUsd)} AI budget this month (about ${dollars(month.costUsd)}). Captures still work; your provider keeps charging your key.`,
    };
  }
  if (share >= 0.8) return { level: "near", text: `You've used about ${dollars(month.costUsd)} of your ${dollars(budgetUsd)} AI budget this month.` };
  return null;
}
