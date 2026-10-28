import { describe, it, expect, vi } from "vitest";
import { createHostedSession, interpretResponse } from "../mcp-server";

/**
 * The proxy used to call res.json() directly, so any non-JSON reply surfaced in
 * the user's MCP client as "Unexpected token '<'" — the same opaque failure
 * CLAUDE.md documents on the browser side, with no hint that the server had
 * actually returned a 500 or a block page.
 */
describe("interpretResponse", () => {
  it("parses a normal JSON-RPC reply", () => {
    const r = interpretResponse(200, "application/json", '{"jsonrpc":"2.0","id":1,"result":{}}');
    expect(r).toHaveProperty("data");
    expect((r as { data: Record<string, unknown> }).data.id).toBe(1);
  });

  it("names the status instead of a parse error when HTML comes back", () => {
    const html = "<!DOCTYPE html><html><body>Internal Server Error</body></html>";
    const r = interpretResponse(500, "text/html; charset=utf-8", html) as { error: string };
    expect(r.error).toContain("HTTP 500");
    expect(r.error).toContain("non-JSON");
    expect(r.error).not.toContain("Unexpected token");
  });

  it("includes a snippet of the body so the cause is visible", () => {
    const r = interpretResponse(403, "text/plain", "Host not in allowlist: example.com") as {
      error: string;
    };
    expect(r.error).toContain("Host not in allowlist");
  });

  it("collapses whitespace and truncates a long body", () => {
    const r = interpretResponse(502, "text/html", "x\n\n   y" + "z".repeat(500)) as {
      error: string;
    };
    expect(r.error).toContain("x y");
    expect(r.error.length).toBeLessThan(300);
  });

  it("handles a missing content-type without crashing", () => {
    const r = interpretResponse(504, null, "gateway timeout") as { error: string };
    expect(r.error).toContain("HTTP 504");
  });

  it("reports malformed JSON distinctly from non-JSON", () => {
    const r = interpretResponse(200, "application/json", "{not valid") as { error: string };
    expect(r.error).toContain("malformed JSON");
  });

  it("does not mistake an empty body for a parse failure message", () => {
    const r = interpretResponse(204, "text/plain", "") as { error: string };
    expect(r.error).toContain("HTTP 204");
    expect(r.error.endsWith(")")).toBe(true); // no trailing empty snippet
  });
});

/**
 * The hosted server learns which agent is calling from `initialize` and keeps
 * it in the Mcp-Session-Id it returns. The stdio client never sees HTTP
 * headers, so the proxy holds the session id and sends it on every later call.
 */
describe("createHostedSession", () => {
  type Call = { body: Record<string, unknown>; session: string | null };

  function fakeHosted(replies: Array<{ status?: number; session?: string; body: unknown }>) {
    const calls: Call[] = [];
    const fetchFn = vi.fn(async (_url: string, init: { headers: Record<string, string>; body: string }) => {
      calls.push({ body: JSON.parse(init.body) as Record<string, unknown>, session: init.headers["Mcp-Session-Id"] ?? null });
      const r = replies.shift()!;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (r.session) headers["mcp-session-id"] = r.session;
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers });
    });
    return { calls, fetchFn: fetchFn as unknown as typeof fetch };
  }

  const init = { jsonrpc: "2.0" as const, id: 1, method: "initialize", params: { clientInfo: { name: "codex" } } };
  const call = { jsonrpc: "2.0" as const, id: 2, method: "tools/call", params: { name: "list_inbox" } };

  it("sends no session before initialize, then the one initialize returned", async () => {
    const { calls, fetchFn } = fakeHosted([
      { session: "s1", body: { jsonrpc: "2.0", id: 1, result: {} } },
      { body: { jsonrpc: "2.0", id: 2, result: { ok: true } } },
    ]);
    const hosted = createHostedSession("key", "https://xkg.test/api/mcp", fetchFn);

    await hosted.send(init);
    const reply = await hosted.send(call);

    expect(calls.map((c) => c.session)).toEqual([null, "s1"]);
    expect(reply).toEqual({ data: { jsonrpc: "2.0", id: 2, result: { ok: true } } });
  });

  it("opens a new session when the old one expired, and retries the call once", async () => {
    const { calls, fetchFn } = fakeHosted([
      { session: "s1", body: { jsonrpc: "2.0", id: 1, result: {} } },
      { status: 404, body: { jsonrpc: "2.0", id: 2, error: { code: -32001, message: "Session not found" } } },
      { session: "s2", body: { jsonrpc: "2.0", id: 1, result: {} } },
      { body: { jsonrpc: "2.0", id: 2, result: { ok: true } } },
    ]);
    const hosted = createHostedSession("key", "https://xkg.test/api/mcp", fetchFn);

    await hosted.send(init);
    const reply = await hosted.send(call);

    expect(calls.map((c) => [c.body.method, c.session])).toEqual([
      ["initialize", null],
      ["tools/call", "s1"],
      ["initialize", null],
      ["tools/call", "s2"],
    ]);
    expect(reply).toEqual({ data: { jsonrpc: "2.0", id: 2, result: { ok: true } } });
  });

  it("passes a 404 through when it held no session", async () => {
    const { calls, fetchFn } = fakeHosted([
      { status: 404, body: { jsonrpc: "2.0", id: 2, error: { code: -32001, message: "Session not found" } } },
    ]);
    const hosted = createHostedSession("key", "https://xkg.test/api/mcp", fetchFn);

    const reply = await hosted.send(call);

    expect(calls).toHaveLength(1);
    expect(reply).toEqual({ data: { jsonrpc: "2.0", id: 2, error: { code: -32001, message: "Session not found" } } });
  });

  it("reports an unreachable server as an error", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const hosted = createHostedSession("key", "https://xkg.test/api/mcp", fetchFn);
    expect(await hosted.send(call)).toEqual({ error: "Could not reach xkg at https://xkg.test/api/mcp: offline" });
  });
});
