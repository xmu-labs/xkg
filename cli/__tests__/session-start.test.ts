import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Every coding agent's SessionStart hook runs the same command,
 * `xkg session-start --agent <name>`. It counts new captures and asks the agent
 * to offer them, in the output shape that agent's hook reads.
 */

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join("");
}

function reply(text: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ result: { content: [{ text }] } }), { status: 200, headers });
}

describe("sessionStart", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body)) as { method: string };
      if (body.method === "initialize") return Promise.resolve(reply("", { "mcp-session-id": "start-session" }));
      return Promise.resolve(reply("3 capture(s) in inbox:\n\n- a\n- b\n- c"));
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function sent(): Array<{ method: string; name?: string; session?: string }> {
    return fetchSpy.mock.calls.map(([, init]) => {
      const req = init as RequestInit;
      const body = JSON.parse(String(req.body)) as { method: string; params: { name?: string; clientInfo?: { name: string } } };
      const headers = req.headers as Record<string, string>;
      return { method: body.method, name: body.params.clientInfo?.name ?? body.params.name, session: headers["Mcp-Session-Id"] };
    });
  }

  it("prints the count and the question as plain text when no agent is named", async () => {
    const { sessionStart } = await import("../session-start.js");
    const out = await captureStdout(() => sessionStart("key"));
    expect(out).toContain("You have 3 new xkg captures. Want to see them and apply one here?");
    expect(out).toContain("call the xkg `briefing` tool");
    expect(() => JSON.parse(out)).toThrow();
  });

  it("names itself xkg-session-start and counts the inbox in that session", async () => {
    const { sessionStart } = await import("../session-start.js");
    await captureStdout(() => sessionStart("key"));
    expect(sent()).toEqual([
      { method: "initialize", name: "xkg-session-start", session: undefined },
      { method: "tools/call", name: "list_inbox", session: "start-session" },
    ]);
  });

  it.each(["claude", "codex", "gemini"])("wraps the text in hookSpecificOutput for %s", async (agent) => {
    const { sessionStart } = await import("../session-start.js");
    const out = JSON.parse(await captureStdout(() => sessionStart("key", { agent }))) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toContain("You have 3 new xkg captures.");
  });

  it("uses top-level additionalContext for copilot", async () => {
    const { sessionStart } = await import("../session-start.js");
    const out = JSON.parse(await captureStdout(() => sessionStart("key", { agent: "copilot" }))) as { additionalContext: string };
    expect(out.additionalContext).toContain("You have 3 new xkg captures.");
  });

  it("uses additional_context for cursor", async () => {
    const { sessionStart } = await import("../session-start.js");
    const out = JSON.parse(await captureStdout(() => sessionStart("key", { agent: "cursor" }))) as { additional_context: string };
    expect(out.additional_context).toContain("You have 3 new xkg captures.");
  });

  it("falls back to plain text for an agent it doesn't know", async () => {
    const { sessionStart } = await import("../session-start.js");
    const out = await captureStdout(() => sessionStart("key", { agent: "aider" }));
    expect(out).toContain("You have 3 new xkg captures.");
    expect(() => JSON.parse(out)).toThrow();
  });

  it("says capture, not captures, for one", async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(reply("1 capture(s) in inbox:\n\n- a")));
    const { sessionStart } = await import("../session-start.js");
    const out = await captureStdout(() => sessionStart("key"));
    expect(out).toContain("You have 1 new xkg capture. Want to see it and apply it here?");
  });

  it("prints nothing when the inbox is empty", async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(reply("Inbox is empty.")));
    const { sessionStart } = await import("../session-start.js");
    expect(await captureStdout(() => sessionStart("key", { agent: "claude" }))).toBe("");
  });

  it("prints nothing and doesn't throw when xkg can't be reached", async () => {
    fetchSpy.mockImplementation(() => Promise.reject(new Error("offline")));
    const { sessionStart } = await import("../session-start.js");
    expect(await captureStdout(() => sessionStart("key", { agent: "codex" }))).toBe("");
  });

  it("prints nothing when the key is rejected", async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(new Response("unauthorized", { status: 401 })));
    const { sessionStart } = await import("../session-start.js");
    expect(await captureStdout(() => sessionStart("bad-key"))).toBe("");
  });

  it("gives up within its time limit when xkg hangs", async () => {
    fetchSpy.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      (init as RequestInit).signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const { sessionStart } = await import("../session-start.js");
    const started = Date.now();
    expect(await captureStdout(() => sessionStart("key", { timeoutMs: 50 }))).toBe("");
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
