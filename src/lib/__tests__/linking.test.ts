import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtractedCapture } from "../types";

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

// Linking makes no model call: any request to a provider fails the test.
const fetchSpy = vi.fn(async () => { throw new Error("linking must not call a provider"); });
vi.stubGlobal("fetch", fetchSpy);

const { linkCapture } = await import("../linking");

const NEW_FILE = `# Multi-agent harness\n\n## Links to memory\n_none yet_\n`;
const related = (n: number) => `inbox/2026-10-0${n}-related-${n}.md`;

beforeEach(() => {
  files.clear();
  githubPut.mockClear();
  fetchSpy.mockClear();
  files.set(`inbox/${SELF}`, { content: NEW_FILE, sha: "sha1" });
  for (const n of [1, 2]) files.set(related(n), { content: `# R${n}\n\n## Links to memory\n_none yet_\n`, sha: `r${n}` });
});

const link = (index: string) => linkCapture("gh", "me/knowledge", capture, SELF, "inbox", index);

describe("linkCapture never links a capture to itself", () => {
  it("returns no links when the index holds only the capture itself", async () => {
    const result = await link(HEADER + row(`inbox/${SELF}`, "Long coding runs"));

    expect(result).toEqual([]);
    expect(githubPut).not.toHaveBeenCalled();
  });

  it("links only to the other captures when the index holds the capture plus 2 related ones", async () => {
    const index = HEADER + row(`inbox/${SELF}`, "Long coding runs") + row(related(1), "Long coding sessions") + row(related(2), "A harness for coding");

    const result = await link(index);

    expect(result.map((r) => r.filename).sort()).toEqual([related(1), related(2)]);
    expect(fetchSpy).not.toHaveBeenCalled();
    const written = files.get(`inbox/${SELF}`)!.content;
    expect(written).not.toContain(SELF);
    expect(written).toContain(related(1));
    expect(written).toContain(related(2));
    const putPaths = githubPut.mock.calls.map((c) => c[2]);
    expect(putPaths.sort()).toEqual([`inbox/${SELF}`, related(1), related(2)].sort());
  });

  it("writes the shared terms as the reason, in the capture and in the back-link", async () => {
    const result = await link(HEADER + row(related(1), "Long coding sessions"));

    expect(result).toEqual([{ filename: related(1), reason: "shared: agents, long, coding" }]);
    expect(files.get(`inbox/${SELF}`)!.content).toContain(`(../${related(1)}) — shared: agents, long, coding`);
    expect(files.get(related(1))!.content).toContain(`(../inbox/${SELF}) — shared: agents, long, coding`);
  });

  it("writes nothing when no other capture shares enough", async () => {
    const result = await link(HEADER + row(related(1), "Unrelated cooking notes").replace("| agents |", "| food |"));

    expect(result).toEqual([]);
    expect(githubPut).not.toHaveBeenCalled();
  });
});
