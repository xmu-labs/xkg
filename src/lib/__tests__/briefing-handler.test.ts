import { describe, it, expect, vi, beforeEach } from "vitest";
import type { User } from "../db";

/**
 * The briefing tool ranks captures with one LLM call and returns them as
 * candidates for the agent to check against the code. A second LLM call used
 * to write the briefing, and it named code files it had never seen.
 *
 * Not covered: ranking quality (the ranker is mocked).
 */

const readFile = vi.fn();
const githubGet = vi.fn();
const rankByRelevance = vi.fn();

vi.mock("../rate-limit", () => ({ consumeQuota: vi.fn() }));
// Only the ranker is an LLM call here. Any other LLM export the handler
// reached for would be missing from this mock and fail the import.
vi.mock("../llm", () => ({
  extractCapture: vi.fn(),
  detectSourceType: () => "text",
  formatDate: () => "2026-01-01",
  buildIndexRow: () => "row",
  rankByRelevance: (...a: unknown[]) => rankByRelevance(...a),
  generateApplicationSuggestions: vi.fn(),
  generatePlan: vi.fn(),
  curateSingle: vi.fn(),
  filterByDateRange: (f: unknown[]) => f,
  paginate: (i: unknown[]) => ({ items: i, total: i.length, offset: 0, limit: 10, hasMore: false }),
  pageFooter: () => "",
  matchIndexRows: (r: unknown[]) => r,
  llmSettings: () => ({}),
}));
vi.mock("../github", () => ({
  githubGet: (...a: unknown[]) => githubGet(...a),
  githubPut: vi.fn(),
  githubDelete: vi.fn(),
  readFile: (...a: unknown[]) => readFile(...a),
  updateIndexEntry: vi.fn(),
}));
vi.mock("../fetch-source", () => ({ safeFetch: vi.fn() }));
vi.mock("../linking", () => ({ linkCapture: vi.fn() }));
vi.mock("../synthesis", () => ({ synthesizeTopic: vi.fn() }));
vi.mock("../apply-events", () => ({ recordApplyEvent: vi.fn() }));

const { handleBriefing } = await import("../mcp/handlers");
const { briefingCandidate, formatBriefing } = await import("../briefing");

const user = { id: 1, github_token: "t", github_repo: "o/r", llm_api_key: "k" } as unknown as User;
const INDEX = "| 2026-10-21 | Fewer tools | inbox/2026-10-21-fewer-tools.md | Short tool lists | mcp |";
const CAPTURE = "# Fewer tools\n\n## Core idea\nShort lists.\n\n## Key takeaways\n- Merge read tools\n\n## Quotes\n";
const RULES = "## mcp\n- Keep tools few\n";

const files: Record<string, string> = {
  "INDEX.md": INDEX,
  "inbox/2026-10-21-fewer-tools.md": CAPTURE,
  "RULES.md": RULES,
};

beforeEach(() => {
  readFile.mockReset();
  readFile.mockImplementation(async (_t: string, _r: string, path: string) =>
    path in files ? { content: files[path], sha: "s" } : null,
  );
  githubGet.mockReset();
  rankByRelevance.mockReset();
  rankByRelevance.mockResolvedValue([{ filename: "inbox/2026-10-21-fewer-tools.md", score: 0.8, reason: "MCP repo" }]);
});

describe("handleBriefing", () => {
  it("ranks once and returns the captures as candidates for the agent", async () => {
    const text = await handleBriefing(user, { project_context: "repo: xkg" });

    expect(rankByRelevance).toHaveBeenCalledTimes(1);
    expect(rankByRelevance.mock.calls[0]![3]).toBe(5);
    expect(text).toBe(
      formatBriefing([briefingCandidate("inbox/2026-10-21-fewer-tools.md", 0.8, "MCP repo", CAPTURE)], RULES),
    );
  });

  it("leaves the rules out when asked to", async () => {
    const text = await handleBriefing(user, { project_context: "repo: xkg", include_rules: false });
    expect(text).not.toContain("## Rules");
    expect(readFile).not.toHaveBeenCalledWith("t", "o/r", "RULES.md");
  });

  it("skips a ranked capture that can no longer be read", async () => {
    rankByRelevance.mockResolvedValue([
      { filename: "inbox/2026-10-21-fewer-tools.md", score: 0.8, reason: "MCP repo" },
      { filename: "inbox/gone.md", score: 0.9, reason: "x" },
    ]);
    files["INDEX.md"] = `${INDEX}\n| 2026-10-22 | Gone | inbox/gone.md | x | x |`;
    const text = await handleBriefing(user, { project_context: "repo: xkg" });
    expect(text).toMatch(/^xkg briefing: 1 capture may fit this work\./);
    files["INDEX.md"] = INDEX;
  });
});
