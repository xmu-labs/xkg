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
