import { describe, it, expect } from "vitest";
import { budgetAlert, spendLine } from "../spend-format";

/** XKG-144: Settings → AI model says what xkg spent with the user's key this month, in one plain line. */

const base = { calls: 23, tokensIn: 120_000, tokensOut: 30_000, costUsd: 0.41, unpricedCalls: 0 };

describe("spendLine", () => {
  // protects: the line Settings shows; fails_when: calls or the estimate are missing; no_claim: the estimate is right
  it("gives calls and the estimate", () => {
    expect(spendLine(base)).toBe("This month: 23 calls with your key, about $0.41.");
  });

  it("says one call, not one calls", () => {
    expect(spendLine({ ...base, calls: 1, costUsd: 0.02 })).toBe("This month: 1 call with your key, about $0.02.");
  });

  // protects: a tiny spend doesn't read as free; fails_when: $0.004 rounds to $0.00; no_claim: none
  it("says under a cent for tiny spend", () => {
    expect(spendLine({ ...base, costUsd: 0.004 })).toBe("This month: 23 calls with your key, under $0.01.");
  });

  // protects: no fake precision on unknown models; fails_when: unpriced calls are silently priced at $0; no_claim: none
  it("names calls with no price on file", () => {
    expect(spendLine({ ...base, unpricedCalls: 2 })).toBe("This month: 23 calls with your key, about $0.41 plus 2 calls on a model with no price on file.");
  });

  it("gives tokens when no call has a price", () => {
    expect(spendLine({ ...base, costUsd: 0, unpricedCalls: 23 })).toBe("This month: 23 calls with your key, 150k tokens. No price on file for this model.");
  });

  it("says nothing yet for an empty month", () => {
    expect(spendLine({ calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, unpricedCalls: 0 })).toBe("No calls with your key yet this month.");
  });
});

describe("budgetAlert (XKG-145)", () => {
  const month = (costUsd: number) => ({ ...base, costUsd });

  // protects: no budget means no banner; fails_when: a banner shows without a budget; no_claim: none
  it("is null without a budget", () => {
    expect(budgetAlert(month(100), null)).toBeNull();
  });

  // protects: the early warning; fails_when: 80% doesn't warn or 79% does; no_claim: none
  it("warns at 80% of the budget", () => {
    expect(budgetAlert(month(3.99), 5)).toBeNull();
    expect(budgetAlert(month(4), 5)).toEqual({ level: "near", text: "You've used about $4.00 of your $5.00 AI budget this month." });
  });

  // protects: the over-budget notice says captures still work; fails_when: it reads as a block; no_claim: none
  it("says the budget is used up at 100%", () => {
    expect(budgetAlert(month(5.2), 5)).toEqual({
      level: "over",
      text: "You've used your $5.00 AI budget this month (about $5.20). Captures still work; your provider keeps charging your key.",
    });
  });
});
