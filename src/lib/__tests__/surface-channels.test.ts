import { describe, it, expect, vi, beforeEach } from "vitest";
import type { User } from "../db";

/**
 * Each MCP channel that shows the user a capture records it, so an apply can
 * later be split by what surfaced it. Only captures the tool actually returns
 * are recorded, and the tool's output is unchanged.
 *
 * Not covered: what is stored (see surface-events.test.ts).
 */

const readFile = vi.fn();
const rankByRelevance = vi.fn();
const recordSurfaceEvents = vi.fn();

vi.mock("../rate-limit", () => ({ consumeQuota: vi.fn() }));
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
  githubGet: vi.fn(),
  githubPut: vi.fn(),
  githubDelete: vi.fn(),
  readFile: (...a: unknown[]) => readFile(...a),
  updateIndexEntry: vi.fn(),
}));
vi.mock("../fetch-source", () => ({ safeFetch: vi.fn() }));
vi.mock("../linking", () => ({ linkCapture: vi.fn() }));
vi.mock("../synthesis", () => ({ synthesizeTopic: vi.fn() }));
vi.mock("../apply-events", () => ({ recordApplyEvent: vi.fn() }));
vi.mock("../surface-events", () => ({ recordSurfaceEvents: (...a: unknown[]) => recordSurfaceEvents(...a), recordWhereEvent: vi.fn() }));

const { handleBriefing, handleRecall, handleVaultScan } = await import("../mcp/handlers");

const user = { id: 7, github_token: "t", github_repo: "o/r", llm_api_key: "k" } as unknown as User;
const A = "inbox/2026-10-21-fewer-tools.md";
const B = "applied/2026-10-22-short-names.md";
const CAPTURE = "# Fewer tools\n\n## Core idea\nShort lists.\n\n## Key takeaways\n- Merge read tools\n\n## Quotes\n";
const files: Record<string, string> = {
  "INDEX.md": `| 2026-10-21 | Fewer tools | ${A} | x | mcp |\n| 2026-10-22 | Short names | ${B} | x | mcp |`,
  [A]: CAPTURE,
  [B]: CAPTURE,
};

beforeEach(() => {
  readFile.mockReset();
  readFile.mockImplementation(async (_t: string, _r: string, path: string) => (path in files ? { content: files[path], sha: "s" } : null));
  rankByRelevance.mockReset();
  rankByRelevance.mockResolvedValue([
    { filename: A, score: 0.9, reason: "MCP repo" },
    { filename: B, score: 0.8, reason: "names" },
    { filename: "inbox/gone.md", score: 0.85, reason: "deleted" },
  ]);
  recordSurfaceEvents.mockReset();
});

describe("surface events from MCP channels", () => {
  // protects: D6, briefing tags what it showed; fails_when: a returned candidate isn't recorded or an unreadable one is; no_claim: briefing quality
  it("briefing records each candidate it returned", async () => {
    await handleBriefing(user, { project_context: "repo: xkg", include_rules: false });
    expect(recordSurfaceEvents).toHaveBeenCalledWith(7, [A, B], "briefing");
  });

  it("recall records each capture it returned", async () => {
    await handleRecall(user, { context: "tool lists" });
    expect(recordSurfaceEvents).toHaveBeenCalledWith(7, [A, B], "recall");
  });

  it("the vault scan records the one match it surfaced", async () => {
    await handleVaultScan(user, { activity_context: "editing tools.ts" });
    expect(recordSurfaceEvents).toHaveBeenCalledWith(7, [A], "vault");
  });

  it("records nothing when nothing is shown", async () => {
    rankByRelevance.mockResolvedValue([]);
    await handleBriefing(user, { project_context: "repo: xkg" });
    await handleRecall(user, { context: "x" });
    await handleVaultScan(user, { activity_context: "x" });
    expect(recordSurfaceEvents.mock.calls.filter((c) => (c[1] as string[]).length > 0)).toHaveLength(0);
  });
});
