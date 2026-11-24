import { describe, it, expect } from "vitest";
import { normalizeCapture, buildMarkdown, SYSTEM_PROMPT, readUseItWhen } from "../llm";
import { parseCaptureFile } from "../capture-detail";

/**
 * The "Use it when" line: one sentence per capture that names the kind of
 * situation where it helps, without naming its topic, so a later cue from a
 * different field can still find it. The extraction call writes it; the app
 * keeps it only when it follows the rules.
 *
 * Fixtures are synthetic: never copy real captures into this public repo.
 */

const base = {
  slug: "owner-per-alert", inferredTitle: "Alert ownership", inferredAuthor: null,
  inferredUrl: null, inferredType: "notes", coreIdea: "Alerts need a named owner.",
  takeaways: ["one"], quotes: [], tags: ["alerts"], appliedTo: null, lowConfidence: false,
};

const LINE = "Use it when shared work keeps getting dropped because nobody in particular is responsible for it.";

describe("readUseItWhen", () => {
  it("keeps a line that starts with 'Use it when' and has at most 25 words", () => {
    expect(readUseItWhen(LINE)).toBe(LINE);
  });

  it("accepts any casing of the opening words and trims spaces", () => {
    expect(readUseItWhen(`  use it when ${LINE.slice(12)}  `)).toBe(`Use it when ${LINE.slice(12)}`);
  });

  it("joins a line the model broke over several lines into one", () => {
    expect(readUseItWhen("Use it when work\n  gets dropped.")).toBe("Use it when work gets dropped.");
  });

  it("drops a line that does not start with 'Use it when'", () => {
    expect(readUseItWhen("When work gets dropped because nobody owns it.")).toBeNull();
  });

  it("drops a line longer than 25 words", () => {
    const long = `Use it when ${Array.from({ length: 23 }, (_, i) => `w${i}`).join(" ")}`;
    expect(long.split(" ")).toHaveLength(26);
    expect(readUseItWhen(long)).toBeNull();
  });

  it("drops 'none', blanks and non-strings", () => {
    expect(readUseItWhen("none")).toBeNull();
    expect(readUseItWhen("Use it when")).toBeNull();
    expect(readUseItWhen("")).toBeNull();
    expect(readUseItWhen(null)).toBeNull();
    expect(readUseItWhen(42)).toBeNull();
  });
});

describe("normalizeCapture keeps the 'Use it when' line", () => {
  it("adds a valid line as useItWhen", () => {
    expect(normalizeCapture({ ...base, use_it_when: LINE }).useItWhen).toBe(LINE);
  });

  it("leaves the field out when the line breaks the rules", () => {
    expect("useItWhen" in normalizeCapture({ ...base, use_it_when: "Alerts and on-call." })).toBe(false);
  });

  it("gives an empty extraction no line, even if the model wrote one", () => {
    const c = normalizeCapture({ ...base, coreIdea: null, use_it_when: LINE });
    expect("useItWhen" in c).toBe(false);
  });
});

describe("the extraction prompt asks for the line", () => {
  it("lists use_it_when in the JSON contract and states its rules", () => {
    expect(SYSTEM_PROMPT).toContain('"use_it_when": null');
    expect(SYSTEM_PROMPT).toMatch(/Use it when/);
    expect(SYSTEM_PROMPT).toMatch(/25 words/);
  });
});

describe("the capture file carries the line", () => {
  it("writes it to the frontmatter, and the capture page reads it back", () => {
    const capture = normalizeCapture({ ...base, use_it_when: LINE });
    const md = buildMarkdown("2026-11-23", capture, "raw notes", "note");
    expect(md).toContain(`use_it_when: ${LINE}\n`);
    expect(parseCaptureFile(md).useItWhen).toBe(LINE);
  });

  it("writes no line when there is none, and the page reads null", () => {
    const md = buildMarkdown("2026-11-23", normalizeCapture(base), "raw notes", "note");
    expect(md).not.toContain("use_it_when:");
    expect(parseCaptureFile(md).useItWhen).toBeNull();
  });
});
