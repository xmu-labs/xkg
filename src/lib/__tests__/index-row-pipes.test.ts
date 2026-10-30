import { describe, it, expect } from "vitest";
import { buildIndexRow } from "../llm";
import { parseIndexRows } from "../captures";
import type { ExtractedCapture } from "../types";

/** A capture's index row reads back as written, whatever its summary or tags hold. */
describe("buildIndexRow and parseIndexRows round trip", () => {
  // protects: a pipe or newline in the core idea or a tag can't break the table; fails_when: the writer leaves a bare "|" or newline in a cell; no_claim: the 80-character cut
  it("escapes pipes and newlines so the row parses back", () => {
    const capture = { slug: "pipes", coreIdea: "Use A | B\nto pipe output", tags: ["shell|unix", "cli"] } as unknown as ExtractedCapture;
    const row = buildIndexRow("2026-10-28", capture, "2026-10-28-pipes.md", "url");
    expect(row.trimEnd().split("\n")).toHaveLength(1);
    expect(parseIndexRows(row)[0]).toMatchObject({ summary: "Use A | B to pipe output", tags: ["shell|unix", "cli"], type: "url" });
  });
});

describe("buildIndexRow and parseIndexRows, backslashes", () => {
  // protects: a summary ending in a backslash can't swallow the next cell; fails_when: backslashes aren't escaped, so "a\" + "|" reads as an escaped pipe; no_claim: other markdown escapes
  it("keeps backslashes, even right before a pipe", () => {
    const capture = { slug: "paths", coreIdea: "Windows paths like C:\\dir\\ | then a pipe", tags: ["win\\"] } as unknown as ExtractedCapture;
    const row = buildIndexRow("2026-10-28", capture, "2026-10-28-paths.md", "note");
    expect(parseIndexRows(row)[0]).toMatchObject({ summary: "Windows paths like C:\\dir\\ | then a pipe", tags: ["win\\"], type: "note" });
  });
});

describe("buildIndexRow and parseIndexRows, escape characters", () => {
  // protects: text that already looks escaped reads back unchanged; fails_when: a literal "\|" or "\\" in a summary is unescaped on read; no_claim: rows written before escaping
  it("keeps a literal backslash-pipe and double backslash as written", () => {
    const capture = { slug: "esc", coreIdea: "grep a\\|b and \\\\server", tags: ["x"] } as unknown as ExtractedCapture;
    const row = buildIndexRow("2026-10-28", capture, "2026-10-28-esc.md", "note");
    expect(parseIndexRows(row)[0]).toMatchObject({ summary: "grep a\\|b and \\\\server", tags: ["x"], type: "note" });
  });
});
