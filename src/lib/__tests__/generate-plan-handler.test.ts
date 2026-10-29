import { describe, it, expect, vi, beforeEach } from "vitest";
import type { User } from "../db";

/**
 * generate_plan turns captures into a plan. xkg never reads code:
 * `user.github_repo` is the knowledge repo, so a code path looked up there was
 * never found and the plan was written without any code. The agent names the
 * files it has in view, and only those paths reach the plan; the agent checks
 * the plan against the code itself.
 *
 * Not covered: the plan's content (the LLM call is mocked).
 */

const readFile = vi.fn();
const generatePlan = vi.fn();

vi.mock("../rate-limit", () => ({ consumeQuota: vi.fn() }));
vi.mock("../llm", () => ({
  extractCapture: vi.fn(),
  detectSourceType: () => "text",
  formatDate: () => "2026-10-29",
  buildIndexRow: () => "row",
  rankByRelevance: vi.fn(),
  generateApplicationSuggestions: vi.fn(),
  generatePlan: (...a: unknown[]) => generatePlan(...a),
  curateSingle: vi.fn(),
  filterByDateRange: (f: unknown[]) => f,
  paginate: (i: unknown[]) => ({ items: i, total: i.length, offset: 0, limit: 10, hasMore: false }),
  pageFooter: () => "",
  matchIndexRows: (r: unknown[]) => r,
  llmSettings: () => ({}),
}));
vi.mock("../github", () => ({
  githubGet: vi.fn(),
  githubPut: vi.fn(async () => ({ ok: true })),
  githubDelete: vi.fn(),
  readFile: (...a: unknown[]) => readFile(...a),
  updateIndexEntry: vi.fn(),
}));
vi.mock("../fetch-source", () => ({ safeFetch: vi.fn() }));
vi.mock("../linking", () => ({ linkCapture: vi.fn() }));
vi.mock("../synthesis", () => ({ synthesizeTopic: vi.fn() }));
vi.mock("../apply-events", () => ({ recordApplyEvent: vi.fn() }));

const { handleGeneratePlan } = await import("../mcp/handlers");

const user = { id: 1, github_token: "t", github_repo: "o/knowledge", llm_api_key: "k" } as unknown as User;
const CAPTURE = "inbox/2026-10-21-fewer-tools.md";

beforeEach(() => {
  readFile.mockReset();
  readFile.mockImplementation(async (_t: string, _r: string, path: string) => (path === CAPTURE ? { content: "# Fewer tools", sha: "s" } : null));
  generatePlan.mockReset();
  generatePlan.mockResolvedValue("# Plan");
});

const plan = (codebase_files?: unknown) =>
  handleGeneratePlan(user, { selected_captures: [CAPTURE], project_context: "repo: xkg", codebase_files } as never);

describe("generate_plan code context", () => {
  // protects: AC1, no code path is looked up in the knowledge repo; fails_when: readFile is called with a codebase path; no_claim: none
  it("passes the paths the agent named and never reads code from the knowledge repo", async () => {
    await plan(["src/lib/llm.ts", "src/lib/where.ts"]);
    expect(readFile.mock.calls.map((c) => c[2])).toEqual([CAPTURE]);
    expect(generatePlan.mock.calls[0]![3]).toEqual(["src/lib/llm.ts", "src/lib/where.ts"]);
  });

  // protects: code never passes through xkg; fails_when: file contents an agent sends reach the model; no_claim: what the agent itself does with code
  it("never forwards file contents, even when an agent sends them", async () => {
    await plan([{ path: "src/a.ts", content: "const secret = 1" }, "src/b.ts", "export const leaked = 1;\nexport const more = 2;"]);
    expect(JSON.stringify(generatePlan.mock.calls[0])).not.toMatch(/secret|leaked/);
    expect(generatePlan.mock.calls[0]![3]).toEqual(["src/b.ts"]);
  });

  it("keeps at most 5 paths and drops empty or overlong ones", async () => {
    const paths = Array.from({ length: 7 }, (_, i) => `src/f${i}.ts`);
    await plan(["", "a/".repeat(300) + "x.ts", ...paths]);
    expect(generatePlan.mock.calls[0]![3]).toEqual(paths.slice(0, 5));
  });

  it("sends no file list when the agent names none", async () => {
    await plan(undefined);
    expect(generatePlan.mock.calls[0]![3]).toBeUndefined();
  });
});
