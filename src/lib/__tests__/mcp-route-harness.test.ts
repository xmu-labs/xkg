import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * The apply metric breaks counts down by agent. The agent's name arrives once,
 * in `initialize` (clientInfo.name), and is kept in the stateless session id so
 * every later `tools/call` on that session can pass it to the tool handler.
 */

const applyCapture = vi.fn();

vi.mock("@/lib/db", () => ({
  getUserByApiKey: async (key: string) => (key === "good-key" ? { id: 7 } : null),
  getUserById: async () => null,
}));
vi.mock("@/lib/oauth", () => ({
  verifyToken: () => null,
  wwwAuthenticateHeader: () => "Bearer",
}));
vi.mock("@/lib/mcp/handlers", () => ({
  HANDLERS: { apply_capture: (...a: unknown[]) => applyCapture(...a) },
}));

beforeAll(() => {
  process.env.SESSION_SECRET = "test-secret-for-mcp-route-harness";
});

const { POST } = await import("@/app/api/mcp/route");
const { issueMcpSessionId } = await import("@/lib/mcp-session");

function rpc(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("https://xkg.test/api/mcp", {
    method: "POST",
    headers: { authorization: "Bearer good-key", "content-type": "application/json", accept: "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const callApply = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "apply_capture", arguments: { filename: "a.md" } } };

beforeEach(() => {
  applyCapture.mockReset();
  applyCapture.mockResolvedValue("Applied");
});

describe("MCP route passes the agent's name to tool handlers", () => {
  it("passes the name from initialize on later calls with that session", async () => {
    const init = await POST(rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "codex-mcp-client" } } }));
    const session = init.headers.get("mcp-session-id");
    expect(session).toBeTruthy();

    await POST(rpc(callApply, { "mcp-session-id": session! }));

    expect(applyCapture).toHaveBeenCalledWith({ id: 7 }, { filename: "a.md" }, { harness: "codex-mcp-client" });
  });

  it("passes unknown when the call carries no session", async () => {
    await POST(rpc(callApply));
    expect(applyCapture).toHaveBeenCalledWith({ id: 7 }, { filename: "a.md" }, { harness: "unknown" });
  });

  it("passes unknown when initialize had no usable client name", async () => {
    const init = await POST(rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "<script>" } } }));
    await POST(rpc(callApply, { "mcp-session-id": init.headers.get("mcp-session-id")! }));
    expect(applyCapture).toHaveBeenCalledWith({ id: 7 }, { filename: "a.md" }, { harness: "unknown" });
  });

  it("sends the agent xkg's instructions on initialize", async () => {
    const { SERVER_INSTRUCTIONS } = await import("@/lib/mcp/instructions");
    const init = await POST(rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "codex-mcp-client" } } }));
    const body = (await init.json()) as { result: { instructions?: string } };
    expect(body.result.instructions).toBe(SERVER_INSTRUCTIONS);
  });

  it("passes unknown for another user's session", async () => {
    await POST(rpc(callApply, { "mcp-session-id": issueMcpSessionId(8, "claude-code") }));
    expect(applyCapture).toHaveBeenCalledWith({ id: 7 }, { filename: "a.md" }, { harness: "unknown" });
  });
});
