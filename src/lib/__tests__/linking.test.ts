import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtractedCapture, RelatedCapture } from "../types";

/**
 * A capture must never appear in its own "Links to memory". The web capture
 * route appends the new row to INDEX.md before linking, so the capture is in
 * its own candidate list unless linking takes it out.
 */

const SELF = "2026-10-30-multi-agent-harness-long-running-coding.md";

const capture = {
  slug: "multi-agent-harness-long-running-coding", inferredTitle: "Multi-agent harness", inferredAuthor: null,
  inferredUrl: null, inferredType: "article", coreIdea: "Long coding runs need a harness.", takeaways: ["Split roles."],
  quotes: [], tags: ["agents"], appliedTo: null, lowConfidence: false,
} as unknown as ExtractedCapture;

const row = (file: string, summary: string) => `| 2026-10-30 | [${file.replace(/\.md$/, "")}](${file}) | ${summary}... | agents | url |\n`;
const HEADER = "# Index\n\n| Date | Capture | Summary | Tags | Source |\n|---|---|---|---|---|\n";

const files = new Map<string, { content: string; sha: string }>();
const githubPut = vi.fn(async (_t: string, _r: string, path: string, content: string) => {
  files.set(path, { content, sha: "sha2" });
  return { ok: true };
});
vi.mock("../github", () => ({
  githubPut: (...a: [string, string, string, string]) => githubPut(...a),
  readFile: async (_t: string, _r: string, path: string) => files.get(path) ?? null,
}));

// Stands in for the model: returns every capture row it is shown, in index
// order, unless a test sets its own answer.
let modelAnswer: RelatedCapture[] | null = null;
const findRelatedCaptures = vi.fn(async (_k: string, _c: ExtractedCapture, index: string): Promise<RelatedCapture[]> =>
  modelAnswer ?? [...index.matchAll(/\]\(([^)]+\.md)\)/g)].map((m) => ({ filename: m[1]!, reason: "related" })));
vi.mock("../llm", () => ({ findRelatedCaptures: (...a: [string, ExtractedCapture, string]) => findRelatedCaptures(...a) }));

const { linkCapture } = await import("../linking");

const NEW_FILE = `# Multi-agent harness\n\n## Links to memory\n_none yet_\n`;
const related = (n: number) => `inbox/2026-10-0${n}-related-${n}.md`;

beforeEach(() => {
  files.clear();
  githubPut.mockClear();
  findRelatedCaptures.mockClear();
  modelAnswer = null;
  files.set(`inbox/${SELF}`, { content: NEW_FILE, sha: "sha1" });
  for (const n of [1, 2]) files.set(related(n), { content: `# R${n}\n\n## Links to memory\n_none yet_\n`, sha: `r${n}` });
});

const link = (index: string) => linkCapture("key", "gh", "me/knowledge", capture, SELF, "inbox", index);

describe("linkCapture never links a capture to itself", () => {
  it("returns no links when the index holds only the capture itself", async () => {
    const result = await link(HEADER + row(`inbox/${SELF}`, "Long coding runs"));

    expect(result).toEqual([]);
    expect(findRelatedCaptures).not.toHaveBeenCalled();
    expect(githubPut).not.toHaveBeenCalled();
  });

  it("links only to the other captures when the index holds the capture plus 2 related ones", async () => {
    const index = HEADER + row(`inbox/${SELF}`, "Long coding runs") + row(related(1), "One") + row(related(2), "Two");

    const result = await link(index);

    expect(result.map((r) => r.filename)).toEqual([related(1), related(2)]);
    expect(findRelatedCaptures.mock.calls[0]![2]).not.toContain(SELF);
    const written = files.get(`inbox/${SELF}`)!.content;
    expect(written).not.toContain(SELF);
    expect(written).toContain(related(1));
    expect(written).toContain(related(2));
    const putPaths = githubPut.mock.calls.map((c) => c[2]);
    expect(putPaths.sort()).toEqual([`inbox/${SELF}`, related(1), related(2)].sort());
  });

  it("drops the capture when the model names it anyway, by path or by bare filename", async () => {
    modelAnswer = [
      { filename: `inbox/${SELF}`, reason: "a possible duplicate worth consolidating" },
      { filename: SELF, reason: "same" },
      { filename: `applied/${SELF}`, reason: "same" },
      { filename: related(1), reason: "related" },
    ];

    const result = await link(HEADER + row(related(1), "One"));

    expect(result).toEqual([{ filename: related(1), reason: "related" }]);
    expect(files.get(`inbox/${SELF}`)!.content).not.toContain("duplicate worth consolidating");
  });

  it("writes nothing when the model's only pick is the capture itself", async () => {
    modelAnswer = [{ filename: `inbox/${SELF}`, reason: "a possible duplicate worth consolidating" }];

    const result = await link(HEADER + row(related(1), "One"));

    expect(result).toEqual([]);
    expect(githubPut).not.toHaveBeenCalled();
  });
});
