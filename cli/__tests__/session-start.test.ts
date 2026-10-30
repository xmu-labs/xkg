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
    await captureStdout(() => sessionStart("key", { repo: null }));
    expect(sent()).toEqual([
      { method: "initialize", name: "xkg-session-start", session: undefined },
      { method: "tools/call", name: "search", session: "start-session" },
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

  // protects: the offer is made once per session; fails_when: a chat the agent compacted or forked (Claude Code, Codex) gets the offer again mid-session, or calls xkg for it; no_claim: how each agent fills `source` (QA runs each agent's input shape)
  it.each(["compact", "fork"])("stays quiet, without calling xkg, when the agent says the session continues (%s)", async (source) => {
    const { sessionStart } = await import("../session-start.js");
    const input = JSON.stringify({ session_id: "s1", hook_event_name: "SessionStart", source });
    expect(await captureStdout(() => sessionStart("key", { agent: "codex", repo: null, input }))).toBe("");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // protects: a new, resumed or cleared session still gets the offer in every agent; fails_when: a start source, a hook with no source (Cursor), no input or unreadable input loses the offer; no_claim: none
  it.each([
    '{"source":"startup"}',
    '{"source":"resume"}',
    '{"source":"clear"}',
    '{"source":"new"}',
    '{"session_id":"s1","is_background_agent":false}',
    "",
    "not json",
    "null",
  ])("offers as usual for hook input %j", async (input) => {
    const { sessionStart } = await import("../session-start.js");
    const out = await captureStdout(() => sessionStart("key", { repo: null, input }));
    expect(out).toContain("You have 3 new xkg captures.");
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

  // Regression: ISSUE-001 — each call got the full time limit, so a hung server held the session twice as long
  // Found by /qa on 2026-10-29
  // Report: .gstack/qa-reports/qa-report-session-start-2026-10-29.md
  it("shares one time limit across both calls", async () => {
    fetchSpy.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      (init as RequestInit).signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const { sessionStart } = await import("../session-start.js");
    const started = Date.now();
    await captureStdout(() => sessionStart("key", { timeoutMs: 300 }));
    expect(Date.now() - started).toBeLessThan(450);
  });

  describe("in a repo with captures waiting for it", () => {
    const OFFER = "xkg: 2 captures fit this repo (acme/app). Want to see them and apply one?\n\n## Waiting for you in acme/app\n1. A · Strong fit · inbox/a.md";

    function serve(briefing: string) {
      fetchSpy.mockImplementation((_url, init) => {
        const body = JSON.parse(String((init as RequestInit).body)) as { method: string; params: { name?: string } };
        if (body.method === "initialize") return Promise.resolve(reply("", { "mcp-session-id": "start-session" }));
        return Promise.resolve(reply(body.params.name === "briefing" ? briefing : "3 capture(s) in inbox:\n\n- a\n- b\n- c"));
      });
    }

    function args(): unknown[] {
      return fetchSpy.mock.calls.map(([, init]) => (JSON.parse(String((init as RequestInit).body)) as { params: { arguments?: unknown } }).params.arguments).filter(Boolean);
    }

    // protects: AC20, the hook prints exactly what a briefing call with the same repo returns; fails_when: the text is reworded or wrapped differently from the server's; no_claim: the server's text (briefing test)
    it("asks briefing with only the repo and prints its text as is", async () => {
      serve(OFFER);
      const { sessionStart } = await import("../session-start.js");
      const out = await captureStdout(() => sessionStart("key", { repo: "acme/app" }));
      expect(out).toBe(`${OFFER}\n`);
      expect(args()[0]).toEqual({ repo: "acme/app" });
    });

    // protects: every agent's hook format carries the same offer; fails_when: an agent gets the inbox count instead; no_claim: none
    it("wraps the offer for the agent's hook", async () => {
      serve(OFFER);
      const { sessionStart } = await import("../session-start.js");
      const out = JSON.parse(await captureStdout(() => sessionStart("key", { repo: "acme/app", agent: "claude" }))) as { hookSpecificOutput: { additionalContext: string } };
      expect(out.hookSpecificOutput.additionalContext).toBe(OFFER);
    });

    // protects: today's inbox offer stays when nothing waits for the repo; fails_when: the hook prints the "nothing waiting" line or nothing at all; no_claim: none
    it("counts the inbox as before when nothing waits", async () => {
      serve("No captures are waiting for acme/app.");
      const { sessionStart } = await import("../session-start.js");
      const out = await captureStdout(() => sessionStart("key", { repo: "acme/app" }));
      expect(out).toContain("You have 3 new xkg captures.");
      expect(out).not.toContain("No captures are waiting");
    });
  });

  describe("currentRepo", () => {
    // protects: the hook finds owner/name from the repo's origin, and nothing outside a repo; fails_when: a repo without origin, or a plain folder, yields a name; no_claim: unusual remote hosts (code-map test)
    it("reads owner/name from origin", async () => {
      const { mkdtempSync } = await import("fs");
      const { tmpdir } = await import("os");
      const { join } = await import("path");
      const { execFileSync } = await import("child_process");
      const { currentRepo } = await import("../session-start.js");
      const dir = mkdtempSync(join(tmpdir(), "xkg-start-"));
      expect(currentRepo(dir)).toBeNull();
      execFileSync("git", ["init", "-q"], { cwd: dir });
      expect(currentRepo(dir)).toBeNull();
      execFileSync("git", ["remote", "add", "origin", "git@github.com:Acme/App.git"], { cwd: dir });
      expect(currentRepo(dir)).toBe("Acme/App");
    });
  });
});
