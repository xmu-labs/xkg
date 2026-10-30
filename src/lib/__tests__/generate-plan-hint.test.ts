import { describe, it, expect, vi } from "vitest";

/** After generate_plan, the reply says how to run the plan with the user's own coding agent. */

vi.mock("@/lib/github", async (orig) => ({
  ...(await orig<typeof import("@/lib/github")>()),
  readFile: async (_t: string, _r: string, path: string) => ({ content: `# ${path}`, sha: "s" }),
  githubPut: async () => {},
}));
vi.mock("@/lib/llm", async (orig) => ({
  ...(await orig<typeof import("@/lib/llm")>()),
  generatePlan: async () => "# Implementation Plan: Retry",
  formatDate: () => "2026-10-29",
}));

const { handleGeneratePlan } = await import("@/lib/mcp/handlers");

const user = { id: 7, github_token: "t", github_repo: "acme/knowledge", llm_api_key: "sk", llm_provider: "openai" } as Parameters<typeof handleGeneratePlan>[0];

describe("generate_plan's closing hint", () => {
  // protects: the hint names `xkg agent` only; fails_when: it still mentions the removed `xkg kos`; no_claim: the plan text
  it("names xkg agent and not the old name", async () => {
    const reply = await handleGeneratePlan(user, { selected_captures: ["2026-10-01-retry.md"], project_context: "acme/app" });
    expect(reply).toContain("    xkg agent --plan 2026-10-29-plan-retry.md\n");
    expect(reply).not.toMatch(/\bkos\b/);
  });
});
