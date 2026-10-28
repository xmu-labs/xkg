import { describe, it, expect, vi } from "vitest";
import type { User } from "../db";
import { buildSource } from "../evidence";

/**
 * MCP captures used to keep no source text at all, so their evidence quotes
 * could never be re-checked. The file must carry the text the quotes were
 * checked against, with its hash.
 */

const src = buildSource("Alerts without a named owner get ignored.\n\nEvery alert needs one owner.");
const capture = {
  slug: "alerts-need-owner", inferredTitle: "Alert ownership", inferredAuthor: null, inferredUrl: null,
  inferredType: "notes", coreIdea: "Alerts need a named owner.", takeaways: [], quotes: [], tags: ["alerts"],
  appliedTo: null, lowConfidence: false, source: src,
  claims: [{ id: "c-0123456789ab", outputPath: "/coreIdea", text: "Alerts need a named owner.", kind: "source_assertion",
    evidence: [{ sourceId: src.sourceId, sourceVersionId: src.sourceVersionId, segmentId: "s1", exactQuote: "named owner" }] }],
};

const githubPut = vi.fn();
vi.mock("../rate-limit", () => ({ consumeQuota: async () => ({ allowed: true, limit: 60, resetIn: 0 }), CAPTURE_QUOTA: 60, QUOTA_WINDOW_SECONDS: 3600 }));
vi.mock("../llm", async (orig) => ({
  ...(await orig<typeof import("../llm")>()),
  extractCapture: async () => capture,
}));
vi.mock("../github", () => ({
  githubGet: async () => ({ ok: false }), githubPut: (...a: unknown[]) => githubPut(...a), githubDelete: vi.fn(),
  readFile: async () => null, updateIndexEntry: vi.fn(),
}));
vi.mock("../fetch-source", () => ({ safeFetch: vi.fn() }));
vi.mock("../linking", () => ({ linkCapture: vi.fn() }));
vi.mock("../synthesis", () => ({ synthesizeTopic: vi.fn() }));

const { handleCapture } = await import("../mcp/handlers");
const user = { id: 7, llm_api_key: "k", github_repo: "o/r", llm_provider: "openai" } as unknown as User;

describe("MCP capture keeps the checked source", () => {
  it("writes the source text, its hash and the evidence to the capture file", async () => {
    await handleCapture(user, { content: "Alerts without a named owner get ignored." });
    const markdown = githubPut.mock.calls[0]![3] as string;
    expect(markdown).toContain(`source_sha256: ${src.sha256}`);
    expect(markdown).toContain("## Evidence");
    expect(markdown).toContain("[s1] Alerts without a named owner get ignored.");
  });
});

describe("MCP capture has its own Links to memory section before the source text", () => {
  it("so auto-linking edits that section, never a heading inside the stored source", async () => {
    githubPut.mockClear();
    await handleCapture(user, { content: "x" });
    const markdown = githubPut.mock.calls[0]![3] as string;
    const links = markdown.indexOf("## Links to memory\n_none yet_");
    expect(links).toBeGreaterThan(-1);
    expect(links).toBeLessThan(markdown.indexOf("<summary>Source text"));
  });
});
