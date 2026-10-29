import { describe, it, expect } from "vitest";
import { evidenceScorer, tierOf, type Candidate } from "../where-score";

/**
 * The card's tier comes from a scorer, never from the model's own confidence.
 * The default scorer uses evidence xkg can check: how the file ranked on names,
 * whether its reason passed the name check, and how fresh the map is.
 */

const capture = { title: "t", coreIdea: "c", takeaways: [] };
const cand = (over: Partial<Candidate>): Candidate => ({ repo: "acme/app", path: "a.ts", rel: 0, whyKept: false, fresh: false, ...over });
const p = async (c: Candidate) => (await evidenceScorer.score(capture, [c]))[0]!.p;

describe("tierOf", () => {
  // protects: the tier thresholds; fails_when: 0.7 is not Strong or 0.39 is shown; no_claim: the thresholds are tuned
  it("maps 0.7 and up to strong, 0.4 to 0.7 to possible, below 0.4 to none", () => {
    expect(tierOf(0.7)).toBe("strong");
    expect(tierOf(0.69)).toBe("possible");
    expect(tierOf(0.4)).toBe("possible");
    expect(tierOf(0.39)).toBe("none");
  });

  // protects: each scorer's p is read against its own cutoffs; fails_when: a scorer's cutoffs are ignored; no_claim: none
  it("uses a scorer's own cutoffs when given", () => {
    const cutoffs = { strong: 0.6, possible: 0.3 };
    expect(tierOf(0.6, cutoffs)).toBe("strong");
    expect(tierOf(0.59, cutoffs)).toBe("possible");
    expect(tierOf(0.3, cutoffs)).toBe("possible");
    expect(tierOf(0.29, cutoffs)).toBe("none");
    expect(evidenceScorer.cutoffs).toEqual({ strong: 0.7, possible: 0.4 });
  });
});

describe("evidenceScorer", () => {
  // protects: strong evidence reads as a strong fit; fails_when: the best-ranked file with a checked reason on a fresh map is not Strong; no_claim: real-world precision
  it("rates the top-ranked file with a checked reason on a fresh map as strong", async () => {
    expect(tierOf(await p(cand({ rel: 1, whyKept: true, fresh: true })))).toBe("strong");
  });

  // protects: a pick with nothing behind it is not shown; fails_when: an unranked pick with no reason on an old map gets a tier; no_claim: none
  it("rates an unranked pick with no checked reason on an old map as no fit", async () => {
    expect(tierOf(await p(cand({})))).toBe("none");
  });

  // protects: a model pick the names don't support stays tentative; fails_when: an unranked pick reads as Strong; no_claim: none
  it("rates an unranked pick with a checked reason on a fresh map as possible", async () => {
    expect(tierOf(await p(cand({ whyKept: true, fresh: true })))).toBe("possible");
  });

  // protects: p stays a probability; fails_when: a relative score above 1 pushes p over 1; no_claim: none
  it("keeps p between 0 and 1", async () => {
    expect(await p(cand({ rel: 5, whyKept: true, fresh: true }))).toBe(1);
    expect(await p(cand({ rel: -1 }))).toBeGreaterThanOrEqual(0);
  });

  // protects: one result per candidate, keyed by repo and path; fails_when: results are dropped or reordered; no_claim: none
  it("returns one score per candidate with its repo and path", async () => {
    const out = await evidenceScorer.score(capture, [cand({ path: "a.ts" }), cand({ repo: "acme/b", path: "b.ts", rel: 1 })]);
    expect(out.map((o) => `${o.repo}:${o.path}`)).toEqual(["acme/app:a.ts", "acme/b:b.ts"]);
    expect(evidenceScorer.name).toBe("evidence");
  });
});
