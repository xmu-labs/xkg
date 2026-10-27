import { describe, it, expect, vi, beforeEach } from "vitest";
import type { User } from "../db";

/**
 * The MCP capture tool is the likelier path for a stolen key — it reaches
 * capture directly and every call spends the owner's LLM credits — so it must
 * charge the same budget as the web route, and must charge it *before* doing
 * any paid work.
 *
 * This used to be asserted by reading the route file as text and grepping it,
 * because the handler was module-private inside app/api/mcp/route.ts. Now that
 * handlers live in lib/mcp, the behavior itself is testable.
 */

const consumeQuota = vi.fn();
const extractCapture = vi.fn();

vi.mock("../rate-limit", () => ({
  consumeQuota: (...a: unknown[]) => consumeQuota(...a),
  CAPTURE_QUOTA: 60,
  QUOTA_WINDOW_SECONDS: 3600,
}));
vi.mock("../llm", () => ({
  extractCapture: (...a: unknown[]) => extractCapture(...a),
  detectSourceType: () => "text",
  formatDate: () => "2026-01-01",
  buildIndexRow: () => "row",
  rankByRelevance: () => [],
  composeBriefing: () => "",
  generateApplicationSuggestions: () => "",
  generatePlan: () => "",
  curateSingle: () => ({}),
  filterByDateRange: (f: unknown[]) => f,
  paginate: (i: unknown[]) => ({ items: i, total: i.length, offset: 0, limit: 10, hasMore: false }),
  pageFooter: () => "",
  matchIndexRows: (r: unknown[]) => r,
  llmSettings: (u: { llm_provider: string }) => ({ provider: u.llm_provider }),
}));
vi.mock("../github", () => ({
  githubGet: vi.fn(), githubPut: vi.fn(), githubDelete: vi.fn(),
  readFile: vi.fn(), updateIndexEntry: vi.fn(),
}));
vi.mock("../fetch-source", () => ({ safeFetch: vi.fn() }));
vi.mock("../linking", () => ({ linkCapture: vi.fn() }));
vi.mock("../synthesis", () => ({ synthesizeTopic: vi.fn() }));

const { handleCapture } = await import("../mcp/handlers");

const user = { id: 7, llm_api_key: "k", github_repo: "o/r", llm_provider: "anthropic" } as unknown as User;

beforeEach(() => {
  consumeQuota.mockReset();
  extractCapture.mockReset();
});

describe("MCP capture tool is quota-charged", () => {
  it("charges the same identifier the web route charges, so one budget covers both", async () => {
    consumeQuota.mockResolvedValue({ allowed: false, limit: 60, resetIn: 600 });
    await expect(handleCapture(user, { content: "hi" })).rejects.toThrow(/Rate limit reached/);
    expect(consumeQuota).toHaveBeenCalledWith("capture:user:7");
  });

  it("refuses the call when the budget is spent", async () => {
    consumeQuota.mockResolvedValue({ allowed: false, limit: 60, resetIn: 600 });
    await expect(handleCapture(user, { content: "hi" })).rejects.toThrow(/60 captures\/hour/);
  });

  it("spends nothing on the model when the budget is spent", async () => {
    consumeQuota.mockResolvedValue({ allowed: false, limit: 60, resetIn: 60 });
    await handleCapture(user, { content: "hi" }).catch(() => {});
    expect(extractCapture).not.toHaveBeenCalled();
  });

  it("charges before calling the model, not after", async () => {
    const order: string[] = [];
    consumeQuota.mockImplementation(async () => { order.push("quota"); return { allowed: true, limit: 60, resetIn: 0 }; });
    extractCapture.mockImplementation(async () => { order.push("model"); throw new Error("stop"); });
    await handleCapture(user, { content: "hi" }).catch(() => {});
    expect(order).toEqual(["quota", "model"]);
  });

  it("rejects an unconfigured account before spending quota", async () => {
    const bare = { id: 8 } as unknown as User;
    await expect(handleCapture(bare, { content: "hi" })).rejects.toThrow(/API key not configured/);
    expect(consumeQuota).not.toHaveBeenCalled();
  });
});
