import { describe, it, expect } from "vitest";
import { recommendFaster, nudgeKey, SLOW_MS } from "../model-nudge";
import type { ModelSpeedRow } from "../model-speed";

/**
 * When a capture was slow, the card may offer the provider's measured fast
 * model. It does so only with a fresh measurement that is clearly faster and
 * keeps the checked quotes, and never again for a setup the user chose to keep.
 */

const row: ModelSpeedRow = {
  provider: "openai", fastModel: "gpt-4.1", fastMeanMs: 4700, coverageFast: 0.93,
  slowModel: "gpt-6.1-terra", slowMeanMs: 13200, coverageSlow: 1, sources: 12, measuredOn: "2026-11-01",
};
const slow = { provider: "openai" as const, model: "gpt-6.1-terra", effort: null, extractMs: 25_000, dismissedFor: null, row };

describe("recommendFaster", () => {
  // protects: a slow capture on another model gets the hint with the measured time; fails_when: no hint, or the seconds are off; no_claim: the measurement is current (speedRow)
  it("offers the fast model after a slow capture", () => {
    expect(recommendFaster(slow)).toEqual({ model: "gpt-4.1", tookSeconds: 25, usualSeconds: 5 });
  });

  // protects: fast captures show nothing; fails_when: a capture under the threshold gets the hint; no_claim: none
  it(`stays quiet under ${SLOW_MS / 1000} s`, () => {
    expect(recommendFaster({ ...slow, extractMs: SLOW_MS - 1 })).toBeNull();
  });

  // protects: no hint without the server's time; fails_when: a missing time counts as slow; no_claim: none
  it("stays quiet without the server's time", () => {
    expect(recommendFaster({ ...slow, extractMs: null })).toBeNull();
  });

  // protects: users already on the fast model aren't told to switch to it; fails_when: the hint names the model they use; no_claim: none
  it("stays quiet on the fast model", () => {
    expect(recommendFaster({ ...slow, model: "gpt-4.1" })).toBeNull();
  });

  // protects: "Keep mine" holds for that setup; fails_when: the hint returns for the kept model and effort; no_claim: none
  it("stays quiet for a kept setup", () => {
    expect(recommendFaster({ ...slow, dismissedFor: nudgeKey("gpt-6.1-terra", null) })).toBeNull();
  });

  // protects: a new setup can be offered again; fails_when: keeping one setup silences every other; no_claim: none
  it("comes back when the setup changed", () => {
    expect(recommendFaster({ ...slow, effort: "high", dismissedFor: nudgeKey("gpt-6.1-terra", null) })).not.toBeNull();
  });

  // protects: no measurement, no claim; fails_when: a hint shows without a row or for another provider's row; no_claim: none
  it("stays quiet without a measurement for this provider", () => {
    expect(recommendFaster({ ...slow, row: null })).toBeNull();
    expect(recommendFaster({ ...slow, provider: "anthropic" })).toBeNull();
  });

  // protects: the hint only names a model that is clearly faster than this capture; fails_when: it offers a model about as slow; no_claim: none
  it("stays quiet when the fast model isn't clearly faster", () => {
    expect(recommendFaster({ ...slow, row: { ...row, fastMeanMs: 15_000 } })).toBeNull();
  });

  // protects: never trade checked quotes for speed; fails_when: the hint offers a model that keeps clearly fewer quotes; no_claim: none
  it("stays quiet when the fast model keeps clearly fewer checked quotes", () => {
    expect(recommendFaster({ ...slow, row: { ...row, coverageFast: 0.6, coverageSlow: 1 } })).toBeNull();
  });
});

describe("nudgeKey", () => {
  // protects: the kept value is stable and readable; fails_when: Auto effort has no name; no_claim: none
  it("joins model and effort, Auto when unset", () => {
    expect(nudgeKey("gpt-6.1-terra", null)).toBe("gpt-6.1-terra/auto");
    expect(nudgeKey("gpt-6.1-terra", "high")).toBe("gpt-6.1-terra/high");
  });
});
