import { describe, it, expect } from "vitest";
import { captureName, parseIndexRows } from "../captures";

/**
 * The web app's captures list reads INDEX.md, the same table search reads, so
 * the list and the agent's search always agree on what exists and where.
 */

const INDEX = `# Knowledge Index

| Date | Capture | Summary | Tags | Type |
|------|---------|---------|------|------|
| 2026-10-28 | [llm-memory](inbox/2026-10-28-llm-memory.md) | Memory goes into the prompt.... | llm, memory | article |
| 2026-10-20 | [old-post](archived/2026-10-20-old-post.md) | An old post.... | blog | post |
| 2026-10-25 | [routing](applied/2026-10-25-routing.md) | Route by cost.... | llm |
not a row
`;

describe("parseIndexRows", () => {
  // protects: the list shows each capture with its folder as status; fails_when: a row's path, status, tags or type is misread; no_claim: how rows are written
  it("reads each row's date, path, status, summary, tags and type, newest first", () => {
    expect(parseIndexRows(INDEX)).toEqual([
      { date: "2026-10-28", slug: "llm-memory", filename: "2026-10-28-llm-memory.md", status: "inbox", summary: "Memory goes into the prompt.", tags: ["llm", "memory"], type: "article" },
      { date: "2026-10-25", slug: "routing", filename: "2026-10-25-routing.md", status: "applied", summary: "Route by cost.", tags: ["llm"], type: null },
      { date: "2026-10-20", slug: "old-post", filename: "2026-10-20-old-post.md", status: "archived", summary: "An old post.", tags: ["blog"], type: "post" },
    ]);
  });

  // protects: an index with no captures; fails_when: the header row is read as a capture; no_claim: a missing INDEX.md (the route's job)
  it("returns nothing for an index with only its header", () => {
    expect(parseIndexRows("| Date | Capture | Summary | Tags | Type |\n|---|---|---|---|---|\n")).toEqual([]);
  });

  // protects: a row whose link points outside the three folders is skipped; fails_when: a plans/ or odd link shows as a capture; no_claim: repairing the index
  it("skips rows that don't link a capture in inbox, applied or archived", () => {
    expect(parseIndexRows("| 2026-10-01 | [x](plans/x.md) | x | | |\n| 2026-10-01 | no link | x | | |")).toEqual([]);
  });
});

describe("captureName", () => {
  // protects: the web routes only touch a capture file by its own name; fails_when: a path, '..' or a non-.md name is accepted; no_claim: whether the file exists
  it("accepts a bare capture filename and nothing else", () => {
    expect(captureName("2026-10-28-llm-memory.md")).toBe("2026-10-28-llm-memory.md");
    expect(captureName("inbox/2026-10-28-llm-memory.md")).toBeNull();
    expect(captureName("../INDEX.md")).toBeNull();
    expect(captureName("..md")).toBeNull();
    expect(captureName("notes.txt")).toBeNull();
    expect(captureName(42)).toBeNull();
  });
});
