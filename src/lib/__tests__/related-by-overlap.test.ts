import { describe, it, expect } from "vitest";
import type { ExtractedCapture } from "../types";
import { relatedByOverlap } from "../related";

/**
 * Links at capture time come from what the captures visibly share (tags and
 * words in the title and summary), with no model call. The reason says what
 * they share, so a link never claims more than the overlap shows.
 */

const HEADER = "# Index\n\n| Date | Capture | Summary | Tags | Source |\n|---|---|---|---|---|\n";
const row = (file: string, summary: string, tags: string) =>
  `| 2026-10-30 | [${file.replace(/^.*\//, "").replace(/\.md$/, "")}](${file}) | ${summary}... | ${tags} | url |\n`;

const SELF = "2026-10-31-retry-budgets-for-llm-calls.md";
const capture = {
  slug: "retry-budgets-for-llm-calls",
  inferredTitle: "Retry budgets for LLM calls",
  coreIdea: "Bounded retries with jitter keep provider outages from cascading into timeouts.",
  tags: ["reliability", "llm", "timeouts"],
} as unknown as ExtractedCapture;

const rank = (index: string) => relatedByOverlap(capture, index, `inbox/${SELF}`, SELF);

describe("relatedByOverlap", () => {
  // protects: shared tag plus a shared word links, and the reason names them; fails_when: ranker ignores tags or words; no_claim: semantic relatedness
  it("links a capture that shares a tag and a word, and says what they share", () => {
    const index = HEADER + row("inbox/2026-10-01-circuit-breakers.md", "Circuit breakers stop cascading failures across services", "reliability, architecture");
    expect(rank(index)).toEqual([
      { filename: "inbox/2026-10-01-circuit-breakers.md", reason: "shared: reliability, cascading" },
    ]);
  });

  // protects: one shared tag alone is too weak to link; fails_when: threshold dropped; no_claim: none
  it("skips a capture that shares only one tag", () => {
    const index = HEADER + row("inbox/2026-10-02-prompt-caching.md", "Cache the system prompt to cut input cost", "llm, cost");
    expect(rank(index)).toEqual([]);
  });

  // protects: three shared words link even without a shared tag; fails_when: tags required; no_claim: none
  it("links on three shared words without a shared tag", () => {
    const index = HEADER + row("inbox/2026-10-03-jitter.md", "Jitter on bounded retries avoids provider thundering herds", "distributed-systems");
    expect(rank(index).map((r) => r.reason)).toEqual(["shared: bounded, retries, jitter, provider"]);
  });

  // protects: at most 3 links, strongest first, newer first on ties; fails_when: order or cap changes; no_claim: none
  it("returns at most three, strongest overlap first, newer first on a tie", () => {
    const index =
      HEADER +
      row("inbox/2026-10-04-a.md", "Timeouts for provider calls", "reliability") +
      row("inbox/2026-10-05-b.md", "Timeouts and bounded retries for provider calls", "reliability, llm, timeouts") +
      row("inbox/2026-10-06-c.md", "Timeouts for provider calls", "reliability") +
      row("inbox/2026-10-07-d.md", "Timeouts for provider calls", "reliability") +
      row("inbox/2026-10-08-e.md", "Timeouts for provider calls", "reliability");
    expect(rank(index).map((r) => r.filename)).toEqual([
      "inbox/2026-10-05-b.md",
      "inbox/2026-10-08-e.md",
      "inbox/2026-10-07-d.md",
    ]);
  });

  // protects: a capture never links to itself; fails_when: self row not excluded; no_claim: none
  it("never returns the capture itself, by path or by bare filename", () => {
    const index = HEADER + row(`inbox/${SELF}`, "Retry budgets for LLM calls", "reliability, llm, timeouts") + row(`applied/${SELF}`, "Retry budgets", "reliability, llm");
    expect(rank(index)).toEqual([]);
  });

  // protects: common words never create links; fails_when: stopwords counted; no_claim: none
  it("ignores common words", () => {
    const index = HEADER + row("inbox/2026-10-09-x.md", "From this into their about with which", "reliability");
    expect(rank(index)).toEqual([]);
  });

  // protects: empty or header-only index is handled; fails_when: parser throws; no_claim: none
  it("returns nothing for an index with no capture rows", () => {
    expect(rank("")).toEqual([]);
    expect(rank(HEADER)).toEqual([]);
  });

  // protects: tags compare case-insensitively and escaped pipes don't break a row; fails_when: parser splits on \\|; no_claim: none
  it("compares tags without case and reads rows whose summary has an escaped pipe", () => {
    const index = HEADER + row("inbox/2026-10-10-y.md", "Retries \\| cascading failures", "Reliability");
    expect(rank(index)).toEqual([{ filename: "inbox/2026-10-10-y.md", reason: "shared: reliability, retries, cascading" }]);
  });
});
