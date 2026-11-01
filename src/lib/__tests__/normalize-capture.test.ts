import { describe, it, expect } from "vitest";
import { normalizeCapture, buildIndexRow } from "../llm";
import type { ExtractedCapture } from "../types";

/**
 * Regression coverage for orphaned captures.
 *
 * extractCapture used to do `JSON.parse(raw) as ExtractedCapture` — a cast,
 * not a check. When the model had nothing to work with (a bare URL it could
 * not fetch) it returned nulls for slug/title/coreIdea, the cast let them
 * through, and buildIndexRow threw on `.slice()` of null. By then the capture
 * file was already written, so the file existed with no index row and could
 * not be found by search.
 *
 * Fixtures here are synthetic: never copy captures, file names or URLs from
 * someone's knowledge repository into this public repo.
 */

// The shape an orphaned capture was written from: everything null.
const nullExtraction = {
  slug: null,
  inferredTitle: null,
  inferredAuthor: null,
  inferredUrl: "https://example.com/paper",
  inferredType: null,
  coreIdea: null,
  takeaways: null,
  quotes: null,
  tags: null,
  appliedTo: null,
  lowConfidence: true,
};

describe("normalizeCapture", () => {
  it("survives the null-everything extraction that orphaned captures", () => {
    const c = normalizeCapture(nullExtraction);
    expect(c.slug).toBe("untitled");
    expect(c.inferredTitle).toBe("Untitled capture");
    expect(typeof c.coreIdea).toBe("string");
    expect(c.coreIdea.length).toBeGreaterThan(0);
    expect(c.tags).toEqual([]);
    expect(c.takeaways).toEqual([]);
  });

  it("flags a thin extraction low-confidence even if the model claimed otherwise", () => {
    const c = normalizeCapture({ ...nullExtraction, lowConfidence: false });
    expect(c.lowConfidence).toBe(true);
  });

  it("keeps a good extraction intact", () => {
    const good = {
      slug: "real-slug", inferredTitle: "Real Title", inferredAuthor: "A. Author",
      inferredUrl: "https://example.com", inferredType: "research",
      coreIdea: "A genuine core idea.", takeaways: ["one", "two"],
      quotes: ["q"], tags: ["x", "y"], appliedTo: null, lowConfidence: false,
    };
    // claims are only kept when checked against a source; with none there are none.
    expect(normalizeCapture(good)).toEqual({ ...good, claims: [] });
  });

  it("falls back to a valid ContentType when the model invents one", () => {
    expect(normalizeCapture({ ...nullExtraction, inferredType: "podcast" }).inferredType).toBe("notes");
  });

  it("drops blank and non-string entries from array fields", () => {
    const c = normalizeCapture({ ...nullExtraction, tags: ["ok", "", 42, null, "  "] });
    expect(c.tags).toEqual(["ok"]);
  });

  it("tolerates a non-object payload rather than throwing", () => {
    for (const junk of [null, undefined, "string", 42, []]) {
      expect(() => normalizeCapture(junk)).not.toThrow();
    }
  });
});

describe("buildIndexRow never throws on a degraded capture", () => {
  it("builds a row from the normalized null extraction", () => {
    const row = buildIndexRow("2026-06-02", normalizeCapture(nullExtraction), "f.md", "url");
    expect(row).toContain("[untitled](inbox/f.md)");
    expect(row.startsWith("| 2026-06-02 |")).toBe(true);
  });

  it("does not throw even if a null slips past normalization", () => {
    const bad = { slug: null, coreIdea: null, tags: null } as unknown as ExtractedCapture;
    expect(() => buildIndexRow("2026-06-02", bad, "f.md")).not.toThrow();
  });
});

describe("normalizeCapture stats", async () => {
  const { buildSource } = await import("../evidence");
  const { buildMarkdown } = await import("../llm");
  const source = buildSource("Alpha beta gamma.\n\nDelta epsilon.");

  // protects: the capture records how many claims the model proposed and how many survived the quote check; fails_when: a count is off or dropped takeaways are counted; no_claim: the check itself (evidence tests)
  it("counts proposed claims, kept claims and fields", () => {
    const c = normalizeCapture({
      slug: "s", coreIdea: "Main idea", takeaways: ["T one", "", "T two"],
      claims: [
        { outputPath: "/coreIdea", evidence: [{ segmentId: "s1", exactQuote: "Alpha beta" }] },
        { outputPath: "/takeaways/2", evidence: [{ segmentId: "s2", exactQuote: "Delta" }] },
        { outputPath: "/takeaways/0", evidence: [{ segmentId: "s1", exactQuote: "not in the source" }] },
      ],
    }, source);
    expect(c.stats).toEqual({ claimsProposed: 3, claimsKept: 2, fieldsTotal: 3 });
  });

  // protects: a missing core idea isn't counted as a field; fails_when: fieldsTotal counts the placeholder; no_claim: none
  it("counts only real fields and no claims when the model sent none", () => {
    const c = normalizeCapture({ slug: "s", coreIdea: null, takeaways: ["One"] }, source);
    expect(c.stats).toEqual({ claimsProposed: 0, claimsKept: 0, fieldsTotal: 1 });
  });

  // protects: captures without a source keep today's shape; fails_when: stats appear with nothing checked; no_claim: none
  it("has no stats without a source", () => {
    expect(normalizeCapture({ slug: "s", coreIdea: "x" }).stats).toBeUndefined();
  });

  // protects: the capture file never carries the counts; fails_when: buildMarkdown output changes with stats; no_claim: none
  it("leaves the capture file unchanged", () => {
    const c = normalizeCapture({ slug: "s", coreIdea: "Main idea", takeaways: ["T"] }, source);
    expect(buildMarkdown("2026-01-01", c, "raw")).toBe(buildMarkdown("2026-01-01", { ...c, stats: undefined }, "raw"));
  });
});
