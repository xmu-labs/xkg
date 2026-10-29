import { describe, it, expect, vi, beforeEach } from "vitest";
import type { User } from "../db";

/**
 * generate_plan turns captures into a plan. Code context comes from the agent,
 * which runs next to the code and sends the files it opened. xkg never reads
 * code: `user.github_repo` is the knowledge repo, so a code path looked up
 * there was never found and the plan was written without any code.
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
  it("uses the file contents the agent sent and never reads code from the knowledge repo", async () => {
    await plan([{ path: "src/lib/llm.ts", content: "export function rank() {}" }]);
    expect(readFile.mock.calls.map((c) => c[2])).toEqual([CAPTURE]);
    expect(generatePlan.mock.calls[0]![3]).toEqual([{ path: "src/lib/llm.ts", content: "export function rank() {}" }]);
  });

  // protects: agents still sending paths get a plan and a pointer instead of a silent guess; fails_when: a path is read, or the plan says nothing about it; no_claim: none
  it("skips bare paths without reading them, and says to send contents", async () => {
    const text = await plan(["src/lib/llm.ts"]);
    expect(readFile.mock.calls.map((c) => c[2])).toEqual([CAPTURE]);
    expect(generatePlan.mock.calls[0]![3]).toBeUndefined();
    expect(text).toContain("xkg never reads your code");
    expect(text).toContain("src/lib/llm.ts");
  });

  it("keeps at most 5 files and drops entries without a path and text content", async () => {
    const files = Array.from({ length: 7 }, (_, i) => ({ path: `src/f${i}.ts`, content: `export const f${i} = ${i};` }));
    await plan([{ path: "src/bad.ts" }, { content: "no path" }, ...files]);
    expect(generatePlan.mock.calls[0]![3]).toEqual(files.slice(0, 5));
  });
});
