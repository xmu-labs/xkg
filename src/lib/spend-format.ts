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
