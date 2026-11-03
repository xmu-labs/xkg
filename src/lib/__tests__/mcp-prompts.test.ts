import { describe, it, expect, vi, beforeAll } from "vitest";
import { NextRequest } from "next/server";

/**
 * MCP prompts (XKG-179): a connector client (claude.ai, ChatGPT, Codex cloud)
 * can't run the session-start hook, so it gets one prompt, `briefing`, the
 * user picks to start the same briefing the hook asks for.
 */

vi.mock("@/lib/db", () => ({
  getUserByApiKey: async (key: string) => (key === "good-key" ? { id: 7 } : null),
  getUserById: async () => null,
}));
vi.mock("@/lib/oauth", () => ({
  verifyToken: () => null,
  wwwAuthenticateHeader: () => "Bearer",
}));
vi.mock("@/lib/mcp/handlers", () => ({ HANDLERS: {} }));
vi.mock("@/lib/llm-spend", () => ({ withSpendMeter: (_u: number, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/setup-steps", () => ({ recordSetupStep: async () => {} }));

beforeAll(() => {
  process.env.SESSION_SECRET = "test-secret-for-mcp-prompts";
});

const { POST } = await import("@/app/api/mcp/route");
const { PROMPTS, getPrompt } = await import("@/lib/mcp/prompts");

function rpc(body: unknown): NextRequest {
  return new NextRequest("https://xkg.test/api/mcp", {
    method: "POST",
    headers: { authorization: "Bearer good-key", "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
}

type PromptMessage = { role: string; content: { type: string; text: string } };

describe("MCP prompts", () => {
  // protects: clients only show prompts a server declares; fails_when: initialize leaves `prompts` out of capabilities; no_claim: which clients show them
  it("declares the prompts capability on initialize", async () => {
    const res = await POST(rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    const body = (await res.json()) as { result: { capabilities: Record<string, unknown> } };
    expect(body.result.capabilities).toHaveProperty("prompts");
    expect(body.result.capabilities).toHaveProperty("tools");
  });

  it("lists one prompt, briefing, with an optional repo argument", async () => {
    const res = await POST(rpc({ jsonrpc: "2.0", id: 2, method: "prompts/list", params: {} }));
    const body = (await res.json()) as { result: { prompts: Array<{ name: string; description: string; arguments?: Array<{ name: string; required?: boolean }> }> } };
    expect(body.result.prompts.map((p) => p.name)).toEqual(["briefing"]);
    const [briefing] = body.result.prompts;
    expect(briefing!.description).toMatch(/captures/i);
    expect(briefing!.arguments).toEqual([expect.objectContaining({ name: "repo", required: false })]);
    expect(body.result.prompts).toEqual(PROMPTS);
  });

  // protects: the prompt asks for the same briefing the session-start hook does; fails_when: it names another tool, skips the repo, or asks the user before briefing; no_claim: the model follows it
  it("returns one user message that briefs for the repo before the task", async () => {
    const res = await POST(rpc({ jsonrpc: "2.0", id: 3, method: "prompts/get", params: { name: "briefing", arguments: { repo: "acme/app" } } }));
    const body = (await res.json()) as { result: { description: string; messages: PromptMessage[] } };
    expect(body.result.messages).toHaveLength(1);
    const [msg] = body.result.messages;
    expect(msg!.role).toBe("user");
    expect(msg!.content.type).toBe("text");
    expect(msg!.content.text).toContain('call the xkg `briefing` tool with repo "acme/app"');
    expect(msg!.content.text).toContain("tell the user in one line which captures fit");
    expect(msg!.content.text).toMatch(/never name a file you have not opened/);
    expect(msg!.content.text).not.toContain("Want to see");
  });

  it("asks for the repo from the working copy when none is given", async () => {
    const res = await POST(rpc({ jsonrpc: "2.0", id: 4, method: "prompts/get", params: { name: "briefing" } }));
    const body = (await res.json()) as { result: { messages: PromptMessage[] } };
    const text = body.result.messages[0]!.content.text;
    expect(text).toContain("call the xkg `briefing` tool with repo set to the origin's owner/name");
    expect(text).not.toContain('repo ""');
  });

  // protects: a chat with no repo still gets a useful briefing; fails_when: the prompt only works in a repo; no_claim: none
  it("tells a chat with no repo to call briefing with no arguments", () => {
    const text = getPrompt("briefing", {})!.messages[0]!.content.text;
    expect(text).toMatch(/no repo.*call `briefing` with no arguments/i);
  });

  it("drops a repo that isn't owner/name", () => {
    const text = getPrompt("briefing", { repo: "not a repo\nwith lines" })!.messages[0]!.content.text;
    expect(text).not.toContain("with lines");
    expect(text).toContain("origin's owner/name");
  });

  it("answers an unknown prompt with a JSON-RPC error", async () => {
    const res = await POST(rpc({ jsonrpc: "2.0", id: 5, method: "prompts/get", params: { name: "nope" } }));
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toContain("nope");
  });
});
