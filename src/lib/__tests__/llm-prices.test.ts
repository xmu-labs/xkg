import { describe, it, expect } from "vitest";
import { estimateCostUsd } from "../llm-prices";
import { LLM_PROVIDERS, PROVIDERS } from "../providers";

/**
 * XKG-144: an estimate of what a call cost with the user's key, from list
 * prices per million tokens. A model without a price gives no number rather
 * than a guess.
 */

describe("estimateCostUsd", () => {
  // protects: the dollar figure in Settings; fails_when: input and output prices are swapped or scaled wrong; no_claim: today's list price
  it("prices input and output tokens per million", () => {
    // gpt-4o-mini: $0.15 in, $0.60 out per 1M
    expect(estimateCostUsd("openai", "gpt-4o-mini", 1_000_000, 1_000_000)).toBeCloseTo(0.75, 6);
    expect(estimateCostUsd("openai", "gpt-4o-mini", 2_000, 500)).toBeCloseTo(0.0006, 6);
  });

  // protects: no made-up numbers; fails_when: an unknown or fine-tuned model gets a price; no_claim: none
  it.each([
    ["openai", "ft:gpt-4o-mini-2024-07-18:acme:x:1"],
    ["openrouter", "someone/new-model"],
    ["mistral", "codestral-latest"],
  ] as const)("%s %s has no estimate", (provider, model) => {
    expect(estimateCostUsd(provider, model, 1000, 1000)).toBeNull();
  });

  // protects: every model in the picker gets a number; fails_when: a model is added to the picker without a price; no_claim: the price is current
  it.each(LLM_PROVIDERS.flatMap((p) => PROVIDERS[p].models.map((m) => [p, m] as const)))("%s %s has a price", (provider, model) => {
    expect(estimateCostUsd(provider, model, 1000, 1000)).toBeGreaterThan(0);
  });
});
