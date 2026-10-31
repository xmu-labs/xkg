import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  segmentText,
  buildSource,
  buildExtractionInput,
  checkClaims,
  claimId,
  renderEvidenceSection,
  renderSourceSection,
  sourceText,
} from "../evidence";
import { normalizeCapture, buildMarkdown, SYSTEM_PROMPT } from "../llm";

// Fixtures are synthetic: never copy real captures into this public repo.
const STUDY = [
  "Teams that paired at least twice a week reported shorter review turnaround.",
  "This is an association, not a causal result.",
  "Our sample is small and self-selected.",
].join("\n\n");

describe("segmentText", () => {
  it("splits on blank lines and trims each paragraph", () => {
    expect(segmentText("  one  \n\n\n two \n\nthree")).toEqual(["one", "two", "three"]);
  });

  it("splits a long single block at sentence ends so fetched pages get segments", () => {
    const sentence = "This sentence is about forty characters. ";
    const block = sentence.repeat(40).trim(); // ~1,640 chars, no blank lines
    const segs = segmentText(block);
    expect(segs.length).toBeGreaterThan(1);
    for (const s of segs) expect(s.length).toBeLessThanOrEqual(600);
    expect(segs.join(" ")).toBe(block);
  });

  it("hard-splits a run-on block with no sentence ends", () => {
    const segs = segmentText("x".repeat(1500));
    expect(segs.every((s) => s.length <= 600)).toBe(true);
    expect(segs.join("")).toBe("x".repeat(1500));
  });

  it("returns no segments for blank input", () => {
    expect(segmentText("   \n\n  ")).toEqual([]);
  });
});

describe("buildSource", () => {
  it("numbers segments s1, s2, ... in order", () => {
    const src = buildSource(STUDY);
    expect(src.segments.map((s) => s.segmentId)).toEqual(["s1", "s2", "s3"]);
    expect(src.segments[1]?.text).toBe("This is an association, not a causal result.");
  });

  it("hashes the exact text the quotes are checked against", () => {
    const src = buildSource(STUDY);
    const expected = createHash("sha256").update(sourceText(src)).digest("hex");
    expect(src.sha256).toBe(expected);
    expect(sourceText(src)).toBe(STUDY);
  });

  it("derives the version id from the hash, so the same text gets the same version", () => {
    expect(buildSource(STUDY).sourceVersionId).toBe(buildSource(STUDY).sourceVersionId);
    expect(buildSource(STUDY).sourceVersionId).not.toBe(buildSource(STUDY + "\n\nMore.").sourceVersionId);
  });

  it("keeps the source id stable across versions of the same URL", () => {
    const a = buildSource("first version", { url: "https://example.com/a" });
    const b = buildSource("second version", { url: "https://example.com/a" });
    expect(a.sourceId).toBe(b.sourceId);
    expect(a.sourceVersionId).not.toBe(b.sourceVersionId);
  });

  it("caps the text at maxChars and marks the source truncated", () => {
    const src = buildSource("a".repeat(100), { maxChars: 40 });
    expect(sourceText(src).length).toBe(40);
    expect(src.truncated).toBe(true);
    expect(buildSource("short").truncated).toBe(false);
  });
});

describe("buildExtractionInput", () => {
  // protects: the model has no ids to copy into every quote; fails_when: the input carries sourceId or sourceVersionId; no_claim: none
  it("sends the metadata and segments, not the source ids the app fills in", () => {
    const src = buildSource(STUDY, { url: "https://example.com/study", title: "Pairing study" });
    const input = JSON.parse(buildExtractionInput(src));
    expect(input).not.toHaveProperty("sourceId");
    expect(input).not.toHaveProperty("sourceVersionId");
    expect(input.metadata).toEqual({ title: "Pairing study", url: "https://example.com/study" });
    expect(input.segments).toEqual(src.segments);
  });

  it("tells the model when the text was truncated", () => {
    const src = buildSource("a".repeat(100), { maxChars: 40 });
    expect(JSON.parse(buildExtractionInput(src)).metadata.truncated).toBe(true);
  });
});

describe("checkClaims", () => {
  const src = buildSource(STUDY);
  const ev = (segmentId: string, exactQuote: string) => ({
    sourceId: src.sourceId, sourceVersionId: src.sourceVersionId, segmentId, exactQuote,
  });
  const fields = {
    coreIdea: "Pairing is associated with faster review, not shown to cause it.",
    takeaways: ["The sample is small and self-selected."],
  };

  it("keeps a claim whose quote occurs in the referenced segment", () => {
    const claims = checkClaims([
      { outputPath: "/takeaways/0", text: fields.takeaways[0], kind: "source_assertion",
        evidence: [ev("s3", "small and self-selected")] },
    ], fields, src);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.evidence).toEqual([ev("s3", "small and self-selected")]);
  });

  it("drops evidence whose quote is not in that segment", () => {
    const claims = checkClaims([
      { outputPath: "/takeaways/0", text: fields.takeaways[0], kind: "source_assertion",
        evidence: [ev("s1", "small and self-selected"), ev("s3", "Our sample is small")] },
    ], fields, src);
    expect(claims[0]?.evidence).toEqual([ev("s3", "Our sample is small")]);
  });

  // protects: the shorter answer names only a segment; fails_when: evidence without source ids is dropped or stored without them; no_claim: none
  it("keeps evidence that names only a segment and fills in the source ids", () => {
    const claims = checkClaims([
      { outputPath: "/takeaways/0", evidence: [{ segmentId: "s3", exactQuote: "small and self-selected" }] },
    ], fields, src);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.text).toBe(fields.takeaways[0]);
    expect(claims[0]?.evidence).toEqual([ev("s3", "small and self-selected")]);
  });

  it("drops evidence that cites ids the app never supplied", () => {
    const claims = checkClaims([
      { outputPath: "/coreIdea", text: fields.coreIdea, kind: "source_assertion",
        evidence: [{ ...ev("s2", "an association"), sourceId: "An identifier supplied in the input." },
                   ev("s9", "an association")] },
    ], fields, src);
    expect(claims).toEqual([]);
  });

  it("drops a claim that points at a field that does not exist", () => {
    const claims = checkClaims([
      { outputPath: "/takeaways/4", text: "x", kind: "source_assertion", evidence: [ev("s1", "Teams")] },
      { outputPath: "/appliedTo", text: "x", kind: "source_assertion", evidence: [ev("s1", "Teams")] },
    ], fields, src);
    expect(claims).toEqual([]);
  });

  it("uses the field's own text, not the model's copy of it", () => {
    const claims = checkClaims([
      { outputPath: "/takeaways/0", text: "something else", kind: "source_assertion",
        evidence: [ev("s3", "Our sample")] },
    ], fields, src);
    expect(claims[0]?.text).toBe(fields.takeaways[0]);
  });

  it("matches across whitespace differences but not across wording", () => {
    const claims = checkClaims([
      { outputPath: "/takeaways/0", text: fields.takeaways[0], kind: "source_assertion",
        evidence: [ev("s3", "Our  sample\nis small"), ev("s3", "Our sample was small")] },
    ], fields, src);
    expect(claims[0]?.evidence.map((e) => e.exactQuote)).toEqual(["Our  sample\nis small"]);
  });

  it("gives each claim a stable id derived from the source version and its text", () => {
    const raw = [{ outputPath: "/coreIdea", text: fields.coreIdea, kind: "source_assertion",
      evidence: [ev("s2", "not a causal result")] }];
    const a = checkClaims(raw, fields, src)[0]!;
    const b = checkClaims(raw, fields, src)[0]!;
    expect(a.id).toBe(b.id);
    expect(a.id).toBe(claimId(src.sourceVersionId, fields.coreIdea));
    expect(a.id).toMatch(/^c-[0-9a-f]{12}$/);
  });

  it("tolerates junk instead of throwing", () => {
    for (const junk of [null, "x", 42, [null, 1, { evidence: "no" }]]) {
      expect(checkClaims(junk, fields, src)).toEqual([]);
    }
  });
});

describe("normalizeCapture with a source", () => {
  const src = buildSource(STUDY, { url: "https://example.com/study" });
  const ev = (segmentId: string, exactQuote: string) => ({
    sourceId: src.sourceId, sourceVersionId: src.sourceVersionId, segmentId, exactQuote,
  });
  const parsed = {
    slug: "pairing-review-association", inferredTitle: null, inferredAuthor: null,
    inferredUrl: null, inferredType: null,
    coreIdea: "Pairing is associated with shorter review turnaround.",
    takeaways: ["The sample is small and self-selected."], quotes: [], tags: [],
    appliedTo: null, lowConfidence: false,
    claims: [
      { outputPath: "/coreIdea", text: "Pairing is associated with shorter review turnaround.",
        kind: "source_assertion", evidence: [ev("s1", "shorter review turnaround")] },
      { outputPath: "/takeaways/0", text: "The sample is small and self-selected.",
        kind: "source_assertion", evidence: [ev("s3", "invented quote")] },
    ],
  };

  it("keeps only checked claims and attaches the source", () => {
    const c = normalizeCapture(parsed, src);
    expect(c.claims?.map((x) => x.outputPath)).toEqual(["/coreIdea"]);
    expect(c.source).toBe(src);
  });

  it("does not force low confidence just because the title came back null", () => {
    const c = normalizeCapture(parsed, src);
    expect(c.lowConfidence).toBe(false);
    expect(c.inferredTitle).toBe("Pairing review association");
  });

  it("keeps the supplied URL when the model drops it", () => {
    expect(normalizeCapture(parsed, src).inferredUrl).toBe("https://example.com/study");
  });

  it("returns no claims without a source to check them against", () => {
    expect(normalizeCapture(parsed).claims).toEqual([]);
  });
});

describe("capture markdown with evidence", () => {
  const src = buildSource(STUDY);
  const capture = normalizeCapture({
    slug: "pairing-review-association", inferredTitle: "Pairing study", inferredAuthor: null,
    inferredUrl: null, inferredType: "research",
    coreIdea: "Pairing is associated with shorter review turnaround.",
    takeaways: ["The sample is small and self-selected.", "Unbacked takeaway."],
    quotes: [], tags: ["pairing"], appliedTo: null, lowConfidence: false,
    claims: [
      { outputPath: "/coreIdea", text: "Pairing is associated with shorter review turnaround.",
        kind: "source_assertion",
        evidence: [{ sourceId: src.sourceId, sourceVersionId: src.sourceVersionId, segmentId: "s1",
          exactQuote: "shorter review turnaround" }] },
    ],
  }, src);

  it("lists each checked claim with its id, quote and segment", () => {
    const md = renderEvidenceSection(capture);
    expect(md).toContain("## Evidence");
    expect(md).toContain(capture.claims![0]!.id);
    expect(md).toContain('> "shorter review turnaround" (s1)');
  });

  it("says which takeaways have no checked evidence", () => {
    expect(renderEvidenceSection(capture)).toContain("Takeaway 2: no checked evidence");
  });

  it("stores the checked source text with its hash and segment markers", () => {
    const md = renderSourceSection(capture);
    expect(md).toContain(`sha256: ${src.sha256}`);
    expect(md).toContain("[s2] This is an association, not a causal result.");
  });

  it("writes source ids and hash to the frontmatter and both sections to the file", () => {
    const md = buildMarkdown("2026-10-28", capture, "raw", "paste");
    expect(md).toContain(`source_id: ${src.sourceId}`);
    expect(md).toContain(`source_version: ${src.sourceVersionId}`);
    expect(md).toContain(`source_sha256: ${src.sha256}`);
    expect(md).toContain("## Evidence");
    expect(md).toContain("[s3] Our sample is small and self-selected.");
  });
});

describe("SYSTEM_PROMPT", () => {
  it("is the source-grounded v2 prompt with claim-level evidence", () => {
    expect(SYSTEM_PROMPT.startsWith("You are XKG’s knowledge extraction engine.")).toBe(true);
    expect(SYSTEM_PROMPT).toContain("CLAIM-LEVEL EVIDENCE");
    expect(SYSTEM_PROMPT.trimEnd().endsWith("Return only the JSON object.")).toBe(true);
  });

  // protects: the claim record stays short; fails_when: the prompt asks for source ids or a copy of the field text, or drops the quote limit; no_claim: the model obeys
  it("asks for a segment and one short quote per claim, nothing the app already knows", () => {
    const record = SYSTEM_PROMPT.slice(SYSTEM_PROMPT.indexOf("CLAIM-LEVEL EVIDENCE"), SYSTEM_PROMPT.indexOf("EDGE CASES"));
    expect(record).toContain('"segmentId"');
    expect(record).not.toContain('"sourceId"');
    expect(record).not.toContain('"text"');
    expect(record).toContain("25 words");
  });
});

describe("quote display", () => {
  it("strips quote marks the model copied around a quote, so the file doesn't show them twice", () => {
    const c = normalizeCapture({ coreIdea: "x", quotes: ['"Review stops being an exam."', "“Curly too.”", 'He said "hi" twice'] });
    expect(c.quotes).toEqual(["Review stops being an exam.", "Curly too.", 'He said "hi" twice']);
  });

  it("keeps a multi-line evidence quote on one blockquote line", () => {
    const src = buildSource("Line one\ncontinues here.");
    const capture = normalizeCapture({
      coreIdea: "One idea.", takeaways: [],
      claims: [{ outputPath: "/coreIdea", text: "One idea.", kind: "source_assertion",
        evidence: [{ sourceId: src.sourceId, sourceVersionId: src.sourceVersionId, segmentId: "s1", exactQuote: "one\ncontinues" }] }],
    }, src);
    expect(renderEvidenceSection(capture)).toContain('> "one continues" (s1)');
  });
});

describe("review fixes", () => {
  it("caps a supplied title so it can't bloat the request", () => {
    const src = buildSource("body", { title: "t".repeat(5000) });
    expect(src.title!.length).toBeLessThanOrEqual(300);
  });

  it("keeps claim paths pointing at the right takeaway when blank takeaways are dropped", () => {
    const src = buildSource("Assertion A holds.\n\nAssertion B holds.");
    const ev = (segmentId: string, exactQuote: string) => ({
      sourceId: src.sourceId, sourceVersionId: src.sourceVersionId, segmentId, exactQuote,
    });
    const c = normalizeCapture({
      coreIdea: "Both hold.",
      takeaways: ["", "Assertion A holds.", "Assertion B holds."],
      claims: [
        { outputPath: "/takeaways/1", text: "Assertion A holds.", kind: "source_assertion", evidence: [ev("s1", "Assertion A")] },
        { outputPath: "/takeaways/2", text: "Assertion B holds.", kind: "source_assertion", evidence: [ev("s2", "Assertion B")] },
      ],
    }, src);
    expect(c.takeaways).toEqual(["Assertion A holds.", "Assertion B holds."]);
    expect(c.claims!.map((x) => [x.outputPath, x.text, x.evidence[0]!.segmentId])).toEqual([
      ["/takeaways/0", "Assertion A holds.", "s1"],
      ["/takeaways/1", "Assertion B holds.", "s2"],
    ]);
  });
});
