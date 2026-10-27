import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { dirname, join } from "path";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Capture stdout writes during a callback. */
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

// ── setupHooks / setupPreToolHook ────────────────────────────────────────────

describe("setupHooks", () => {
  let tmpDir: string;
  let settingsPath: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "xkg-test-"));
    settingsPath = join(tmpDir, ".claude", "settings.json");
    origHome = process.env["HOME"];
    process.env["HOME"] = tmpDir;
    // Clear module cache so CLAUDE_SETTINGS_PATH is recomputed with the new HOME
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    process.env["HOME"] = origHome;
  });

  it("installs a SessionStart hook with the provided API key", async () => {
    const { setupHooks } = await import("../hooks.js");
    setupHooks("my-api-key", { silent: true });
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    };
    const cmd = settings.hooks.SessionStart[0]?.hooks[0]?.command ?? "";
    expect(cmd).toContain("inbox-check");
    expect(cmd).toContain("my-api-key");
  });

  it("includes --briefing flag when briefing option is true", async () => {
    const { setupHooks } = await import("../hooks.js");
    setupHooks("key123", { silent: true, briefing: true });
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    };
    const cmd = settings.hooks.SessionStart[0]?.hooks[0]?.command ?? "";
    expect(cmd).toContain("--briefing");
  });

  it("omits --briefing flag when briefing option is false", async () => {
    const { setupHooks } = await import("../hooks.js");
    setupHooks("key123", { silent: true, briefing: false });
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    };
    const cmd = settings.hooks.SessionStart[0]?.hooks[0]?.command ?? "";
    expect(cmd).not.toContain("--briefing");
  });

  it("also installs a PreToolUse hook on file edits when vault option is true", async () => {
    const { setupHooks } = await import("../hooks.js");
    setupHooks("vault-key", { silent: true, vault: true });
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      hooks: { SessionStart: unknown; PreToolUse: Array<{ matcher?: string; hooks: Array<{ command: string }> }> };
    };
    expect(settings.hooks.PreToolUse).toBeDefined();
    expect(settings.hooks.PreToolUse[0]?.matcher).toBe("Edit|Write|MultiEdit");
    const cmd = settings.hooks.PreToolUse[0]?.hooks[0]?.command ?? "";
    expect(cmd).toContain("vault-check");
    expect(cmd).toContain("vault-key");
    expect(settings.hooks).not.toHaveProperty("PreToolCall");
  });

  it("does NOT install a vault hook when vault option is false", async () => {
    const { setupHooks } = await import("../hooks.js");
    setupHooks("no-vault-key", { silent: true, vault: false });
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      hooks: Record<string, unknown>;
    };
    expect(settings.hooks["PreToolUse"]).toBeUndefined();
    expect(settings.hooks["PreToolCall"]).toBeUndefined();
  });

  it("moves a vault hook from the invalid PreToolCall key to PreToolUse, keeping other hooks", async () => {
    const current = "npx -y @xmu-labs/xkg@latest inbox-check --key k";
    const other = "echo unrelated";
    writeSettings({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: current }] }],
        PreToolCall: [{ hooks: [{ type: "command", command: "npx -y @xmu-labs/xkg@latest vault-check --key k" }, { type: "command", command: other }] }],
      },
    });
    const { setupHooks } = await import("../hooks.js");
    setupHooks("k", { silent: true, skipIfExists: true });
    const settings = readSettings();
    expect(commands(settings, "SessionStart")).toEqual([current]);
    expect(commands(settings, "PreToolUse")).toEqual(["npx -y @xmu-labs/xkg@latest vault-check --key k"]);
    expect(commands(settings, "PreToolCall")).toEqual([other]);
  });

  it("replaces an existing xkg hook rather than duplicating it", async () => {
    const { setupHooks } = await import("../hooks.js");
    setupHooks("old-key", { silent: true });
    setupHooks("new-key", { silent: true });
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    };
    const cmds = settings.hooks.SessionStart.flatMap((g) => g.hooks.map((h) => h.command));
    const xkgHooks = cmds.filter((c) => c.includes("inbox-check"));
    expect(xkgHooks).toHaveLength(1);
    expect(xkgHooks[0]).toContain("new-key");
  });

  it("skipIfExists: keeps exactly one xkg hook when called twice", async () => {
    const { setupHooks } = await import("../hooks.js");
    setupHooks("original-key", { silent: true });
    setupHooks("different-key", { silent: true, skipIfExists: true });
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    };
    const cmds = settings.hooks.SessionStart.flatMap((g) => g.hooks.map((h) => h.command));
    expect(cmds.filter((c) => c.includes("inbox-check"))).toHaveLength(1);
  });

  it("installs hooks that run the xkg package at @latest", async () => {
    const { setupHooks } = await import("../hooks.js");
    setupHooks("k", { silent: true, vault: true });
    const settings = readSettings();
    expect(commands(settings, "SessionStart")).toEqual(["npx -y @xmu-labs/xkg@latest inbox-check --key k"]);
    expect(commands(settings, "PreToolUse")).toEqual(["npx -y @xmu-labs/xkg@latest vault-check --key k"]);
  });

  it("skipIfExists: migrates mnemos-capture hooks to xkg, keeping --briefing", async () => {
    writeSettings({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "npx -y mnemos-capture@latest inbox-check --key k --briefing" }] }],
        PreToolCall: [{ hooks: [{ type: "command", command: "npx mnemos-capture vault-check --key k" }] }],
      },
    });
    const { setupHooks, setupPreToolHook } = await import("../hooks.js");
    setupHooks("k", { silent: true, skipIfExists: true });
    setupPreToolHook("k", { silent: true, skipIfExists: true });
    const settings = readSettings();
    expect(commands(settings, "SessionStart")).toEqual(["npx -y @xmu-labs/xkg@latest inbox-check --key k --briefing"]);
    expect(commands(settings, "PreToolUse")).toEqual(["npx -y @xmu-labs/xkg@latest vault-check --key k"]);
    expect(settings.hooks).not.toHaveProperty("PreToolCall");
  });

  it("skipIfExists: leaves a current xkg hook and unrelated hooks alone", async () => {
    const current = "npx -y @xmu-labs/xkg@latest inbox-check --key user-key --briefing";
    const other = "echo inbox-check reminder";
    writeSettings({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: current }, { type: "command", command: other }] }] },
    });
    const { setupHooks } = await import("../hooks.js");
    setupHooks("server-key", { silent: true, skipIfExists: true });
    expect(commands(readSettings(), "SessionStart")).toEqual([current, other]);
  });

  it("skipIfExists: does not treat other packages named like xkg as ours", async () => {
    const scoped = "npx -y @acme/xkg@latest inbox-check --key theirs";
    const prefixed = "npx -y my-xkg inbox-check --key theirs";
    writeSettings({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: scoped }, { type: "command", command: prefixed }] }] },
    });
    const { setupHooks } = await import("../hooks.js");
    setupHooks("k", { silent: true, skipIfExists: true });
    expect(commands(readSettings(), "SessionStart")).toEqual([
      scoped,
      prefixed,
      "npx -y @xmu-labs/xkg@latest inbox-check --key k",
    ]);
  });

  type HookSettings = { hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>> };

  function readSettings(): HookSettings {
    return JSON.parse(readFileSync(settingsPath, "utf-8")) as HookSettings;
  }

  function writeSettings(settings: HookSettings): void {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings));
  }

  function commands(settings: HookSettings, event: string): string[] {
    return (settings.hooks[event] ?? []).flatMap((g) => g.hooks.map((h) => h.command));
  }
});

// ── inboxCheck — briefing mode parsing ───────────────────────────────────────

describe("inboxCheck — briefing mode", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function makeMcpResponse(text: string) {
    return Promise.resolve(
      new Response(
        JSON.stringify({ result: { content: [{ text }] } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }

  it("keeps local agent instructions out of the uploaded briefing context", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "xkg-private-notes-"));
    const originalCwd = process.cwd();
    const privateNote = "PRIVATE_MAINTAINER_NOTE_DO_NOT_UPLOAD";
    try {
      execFileSync("git", ["init", "--quiet", projectDir]);
      writeFileSync(join(projectDir, "CLAUDE.md"), privateNote);
      writeFileSync(join(projectDir, "AGENTS.md"), privateNote);
      process.chdir(projectDir);
      fetchSpy.mockReturnValue(makeMcpResponse(""));

      const { inboxCheck } = await import("../hooks.js");
      await inboxCheck("test-key", { briefing: true });

      expect(fetchSpy).toHaveBeenCalledOnce();
      const request = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)) as {
        params: { name: string; arguments: { project_context: string } };
      };
      expect(request.params.name).toBe("briefing");
      expect(request.params.arguments.project_context).toContain("Project:");
      expect(request.params.arguments.project_context).not.toContain(privateNote);
      expect(request.params.arguments.project_context).not.toContain("CLAUDE.md");
      expect(request.params.arguments.project_context).not.toContain("AGENTS.md");
    } finally {
      process.chdir(originalCwd);
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("strips the JSON block from display output", async () => {
    fetchSpy.mockReturnValue(makeMcpResponse(`\`\`\`json
[{"filename":"inbox/a.md","why":"x","benefit":"y","where":"z.ts","applyNow":true}]
\`\`\`

## Relevant Rules
None applicable.`));

    const { inboxCheck } = await import("../hooks.js");
    const output = await captureStdout(() => inboxCheck("key", { briefing: true }));
    expect(output).not.toContain("```json");
    expect(output).toContain("## Relevant Rules");
  });

  it("appends generate_plan prompt when there are applyNow suggestions", async () => {
    fetchSpy.mockReturnValue(makeMcpResponse(`\`\`\`json
[{"filename":"inbox/a.md","why":"x","benefit":"y","where":"z.ts","applyNow":true}]
\`\`\`

## Apply Now
One insight.`));

    const { inboxCheck } = await import("../hooks.js");
    const output = await captureStdout(() => inboxCheck("key", { briefing: true }));
    expect(output).toContain("generate_plan");
    expect(output).toContain("inbox/a.md");
    expect(output).toContain("apply_capture");
  });

  it("does NOT append generate_plan prompt when all suggestions have applyNow=false", async () => {
    fetchSpy.mockReturnValue(makeMcpResponse(`\`\`\`json
[{"filename":"inbox/b.md","why":"x","benefit":"y","where":"z.ts","applyNow":false}]
\`\`\`

## Knowledge Vault
One vault item.`));

    const { inboxCheck } = await import("../hooks.js");
    const output = await captureStdout(() => inboxCheck("key", { briefing: true }));
    expect(output).not.toContain("generate_plan");
  });

  it("does NOT append generate_plan prompt when JSON block is missing", async () => {
    fetchSpy.mockReturnValue(makeMcpResponse(`## Relevant Rules
None applicable.`));

    const { inboxCheck } = await import("../hooks.js");
    const output = await captureStdout(() => inboxCheck("key", { briefing: true }));
    expect(output).not.toContain("generate_plan");
  });

  it("shows inbox count in non-briefing mode when count > 0", async () => {
    fetchSpy.mockReturnValue(makeMcpResponse("3 capture(s) in inbox:\n\n1. file.md"));

    const { inboxCheck } = await import("../hooks.js");
    const output = await captureStdout(() => inboxCheck("key"));
    expect(output).toContain("3");
    expect(output).toContain("inbox");
  });

  it("shows nothing in non-briefing mode when inbox is empty", async () => {
    fetchSpy.mockReturnValue(makeMcpResponse("Inbox is empty."));

    const { inboxCheck } = await import("../hooks.js");
    const output = await captureStdout(() => inboxCheck("key"));
    expect(output).toBe("");
  });

  it("silently fails when fetch throws", async () => {
    fetchSpy.mockRejectedValue(new Error("Network error"));

    const { inboxCheck } = await import("../hooks.js");
    // Should not throw
    await expect(inboxCheck("key", { briefing: true })).resolves.toBeUndefined();
  });
});

// ── vaultCheck — stdin parsing ────────────────────────────────────────────────

describe("vaultCheck", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let origSessionId: string | undefined;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    origSessionId = process.env["CLAUDE_SESSION_ID"];
    // Use a unique session ID per test to avoid state pollution
    process.env["CLAUDE_SESSION_ID"] = `test-${Date.now()}-${Math.random()}`;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    process.env["CLAUDE_SESSION_ID"] = origSessionId;
  });

  function makeMcpResponse(text: string) {
    return Promise.resolve(
      new Response(
        JSON.stringify({ result: { content: [{ text }] } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }

  it("returns a vault match to the agent as PreToolUse additionalContext", async () => {
    fetchSpy.mockReturnValue(makeMcpResponse(
      "xkg vault match (score: 87%):\n\n**2026-05-01-error-ctx**\nCore idea here.\n- Key takeaway\n\nApply it? Run: `apply_capture` with filename: `inbox/2026-05-01-error-ctx.md`",
    ));

    const { vaultCheck } = await import("../hooks.js");

    // Simulate piped stdin with an Edit tool call
    const hookData = JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: "src/api/capture/route.ts" },
    });

    // Temporarily replace stdin
    const mockStdin = {
      isTTY: false,
      setEncoding: vi.fn(),
      on: vi.fn((event: string, cb: (data?: string) => void) => {
        if (event === "data") cb(hookData);
        if (event === "end") cb();
      }),
    };
    const origStdin = process.stdin;
    Object.defineProperty(process, "stdin", { value: mockStdin, writable: true, configurable: true });

    const output = await captureStdout(() => vaultCheck("key"));

    Object.defineProperty(process, "stdin", { value: origStdin, writable: true, configurable: true });

    const parsed = JSON.parse(output) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("vault match");
  });

  it("outputs nothing when vault_scan returns empty", async () => {
    fetchSpy.mockReturnValue(makeMcpResponse(""));

    const { vaultCheck } = await import("../hooks.js");

    const mockStdin = {
      isTTY: false,
      setEncoding: vi.fn(),
      on: vi.fn((event: string, cb: (data?: string) => void) => {
        if (event === "data") cb(JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "src/foo.ts" } }));
        if (event === "end") cb();
      }),
    };
    const origStdin = process.stdin;
    Object.defineProperty(process, "stdin", { value: mockStdin, writable: true, configurable: true });

    const output = await captureStdout(() => vaultCheck("key"));

    Object.defineProperty(process, "stdin", { value: origStdin, writable: true, configurable: true });

    expect(output).toBe("");
  });

  it("outputs nothing and does not call fetch when tool is not an editing tool", async () => {
    const { vaultCheck } = await import("../hooks.js");

    const mockStdin = {
      isTTY: false,
      setEncoding: vi.fn(),
      on: vi.fn((event: string, cb: (data?: string) => void) => {
        if (event === "data") cb(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }));
        if (event === "end") cb();
      }),
    };
    const origStdin = process.stdin;
    Object.defineProperty(process, "stdin", { value: mockStdin, writable: true, configurable: true });

    await vaultCheck("key");

    Object.defineProperty(process, "stdin", { value: origStdin, writable: true, configurable: true });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("outputs nothing when stdin is a TTY (not piped)", async () => {
    const { vaultCheck } = await import("../hooks.js");

    const mockStdin = { isTTY: true };
    const origStdin = process.stdin;
    Object.defineProperty(process, "stdin", { value: mockStdin, writable: true, configurable: true });

    const output = await captureStdout(() => vaultCheck("key"));

    Object.defineProperty(process, "stdin", { value: origStdin, writable: true, configurable: true });

    expect(output).toBe("");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("silently fails when fetch throws", async () => {
    fetchSpy.mockRejectedValue(new Error("Network error"));

    const { vaultCheck } = await import("../hooks.js");

    const mockStdin = {
      isTTY: false,
      setEncoding: vi.fn(),
      on: vi.fn((event: string, cb: (data?: string) => void) => {
        if (event === "data") cb(JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "src/foo.ts" } }));
        if (event === "end") cb();
      }),
    };
    const origStdin = process.stdin;
    Object.defineProperty(process, "stdin", { value: mockStdin, writable: true, configurable: true });

    await expect(vaultCheck("key")).resolves.toBeUndefined();

    Object.defineProperty(process, "stdin", { value: origStdin, writable: true, configurable: true });
  });
});
