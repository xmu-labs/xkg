import { describe, it, expect } from "vitest";
import { captureStats } from "../capture-stats";

/** The one line under a capture's title: how long it took, the tokens it used, the model. */
describe("captureStats", () => {
  // protects: the user sees time, tokens and model in a short line; fails_when: a part is missing or long; no_claim: none
  it("shows seconds, tokens in thousands and the model", () => {
    expect(captureStats(23_400, { model: "gpt-6.1-terra", tokensIn: 2400, tokensOut: 780 })).toBe("23s · 3.2k tokens · gpt-6.1-terra");
  });

  // protects: small counts stay exact; fails_when: 850 shows as 0.9k; no_claim: none
  it("keeps a count under a thousand exact, and drops a trailing .0", () => {
    expect(captureStats(9_000, { model: "m", tokensIn: 600, tokensOut: 250 })).toBe("9s · 850 tokens · m");
    expect(captureStats(9_000, { model: "m", tokensIn: 1500, tokensOut: 500 })).toBe("9s · 2k tokens · m");
  });

  // protects: a provider that reports no tokens still shows time and model; fails_when: "null tokens" or "NaN" shows; no_claim: none
  it("leaves the tokens out when the provider didn't report them", () => {
    expect(captureStats(12_000, { model: "m", tokensIn: null, tokensOut: null })).toBe("12s · m");
  });

  // protects: a very fast answer doesn't read "0s"; fails_when: 0s shows; no_claim: none
  it("says under 1s for a sub-second answer", () => {
    expect(captureStats(400, { model: "m", tokensIn: 10, tokensOut: 5 })).toBe("under 1s · 15 tokens · m");
  });

  // protects: an older server without usage shows nothing; fails_when: a broken line shows; no_claim: none
  it("returns null without usage", () => {
    expect(captureStats(5_000, undefined)).toBeNull();
  });
});
