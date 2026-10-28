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
