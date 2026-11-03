import { describe, it, expect, vi, beforeEach } from "vitest";
import type { User } from "../db";

/**
 * The setup funnel's "shown" step (XKG-150): an agent that finds a capture
 * through search, reads one with read_capture, or gets one from the older
 * list_inbox, apply_to_context or generate_plan has been shown a capture,
 * even though none of these writes a surface event.
 */

const files = new Map<string, string>();
vi.mock("../github", () => ({
  githubGet: async (_t: string, _r: string, path: string) =>
    path === "inbox" ? { ok: true, data: [...files.keys()].filter((k) => k.startsWith("inbox/")).map((k) => ({ name: k.slice(6) })) } : { ok: false }, githubPut: vi.fn(), githubDelete: vi.fn(),
  readFile: async (_t: string, _r: string, path: string) => (files.has(path) ? { content: files.get(path)!, sha: "s" } : null),
  updateIndexEntry: vi.fn(), appendToIndex: vi.fn(),
}));
const steps: Array<[number, string]> = [];
vi.mock("../setup-steps", () => ({
  recordSetupStep: async (userId: number, step: string) => { steps.push([userId, step]); },
}));

vi.mock("../llm", async (orig) => ({
  ...(await orig<typeof import("../llm")>()),
  rankByRelevance: async () => [{ filename: "inbox/2026-11-02-alert-owners.md" }],
  generateApplicationSuggestions: async () => "Use it in alerts.ts",
  generatePlan: async () => "# Plan",
}));

const { handleSearch, handleReadCapture, handleListInbox, handleApplyToContext, handleGeneratePlan } = await import("../mcp/handlers");
const user = { id: 7, github_token: "t", github_repo: "o/r", llm_api_key: "k", llm_provider: "openai" } as unknown as User;

beforeEach(() => {
  files.clear();
  steps.length = 0;
  files.set("INDEX.md", "| Date | Title |\n|---|---|\n| 2026-11-02 | [Alert owners](inbox/2026-11-02-alert-owners.md) |\n");
  files.set("inbox/2026-11-02-alert-owners.md", "# Alert owners");
  files.set("RULES.md", "# Rules");
  files.set("plans/2026-11-02-plan-alerts.md", "# Plan");
  files.set("applied/2026-10-01-old.md", "# Old");
});

describe("search and read_capture record the shown step", () => {
  // protects: Codex P2 on #188; fails_when: a found or read capture records no shown step; no_claim: once-only (see setup-steps tests)
  it("records it when search returns captures or read_capture returns one", async () => {
    await handleSearch(user, { query: "alert" });
    await handleReadCapture(user, { filename: "2026-11-02-alert-owners.md" });
    await handleReadCapture(user, { filename: "applied/2026-10-01-old.md" });
    expect(steps).toEqual([[7, "shown"], [7, "shown"], [7, "shown"]]);
  });

  // protects: Codex P2 on #188 (round 2), every tool that hands an agent a capture counts; fails_when: list_inbox, apply_to_context or generate_plan records no shown step; no_claim: none
  it("records it from the older tools that hand an agent captures", async () => {
    await handleListInbox(user);
    await handleApplyToContext(user, { task: "alerts" });
    await handleGeneratePlan(user, { selected_captures: ["2026-11-02-alert-owners.md"], project_context: "app" });
    expect(steps).toEqual([[7, "shown"], [7, "shown"], [7, "shown"]]);
  });

  it("records nothing when nothing was shown", async () => {
    await handleSearch(user, { query: "kubernetes" });
    await handleReadCapture(user, { filename: "missing.md" });
    await handleReadCapture(user, { filename: "RULES.md" });
    // `xkg agent --plan` reads a saved plan through read_capture: a plan is not a capture.
    await handleReadCapture(user, { filename: "plans/2026-11-02-plan-alerts.md" });
    await handleGeneratePlan(user, { selected_captures: ["missing.md"], project_context: "app" });
    files.delete("inbox/2026-11-02-alert-owners.md");
    await handleListInbox(user);
    expect(steps).toEqual([]);
  });
});
