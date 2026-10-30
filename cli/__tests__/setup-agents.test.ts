import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  AGENTS,
  RULES_BLOCK,
  detectAgents,
  hookCommand,
  inspectAgent,
  setupAgent,
  type AgentEnv,
  type AgentId,
} from "../setup-agents.js";

/**
 * `xkg init` writes the same three things into every agent it finds: the MCP
 * server (no key), the session-start hook (the README's exact command), and the
 * rules block. Each writer keeps the user's other entries and changes nothing
 * on a second run.
 */

let home: string;
let calls: string[][];
let onPath: Set<string>;

function env(): AgentEnv {
  return {
    home,
    onPath: (cmd) => onPath.has(cmd),
    run: (cmd, args) => {
      calls.push([cmd, ...args]);
      return { ok: true, out: "" };
    },
  };
}

function agent(id: AgentId) {
  return AGENTS.find((a) => a.id === id)!;
}

function file(rel: string): string {
  return readFileSync(join(home, rel), "utf-8");
}

function put(rel: string, content: string): void {
  mkdirSync(dirname(join(home, rel)), { recursive: true });
  writeFileSync(join(home, rel), content);
}

function json(rel: string): Record<string, any> {
  return JSON.parse(file(rel));
}

const MCP_ARGS = ["-y", "@xmu-labs/xkg@latest", "serve-mcp"];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "xkg-agents-"));
  calls = [];
  onPath = new Set();
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("detectAgents", () => {
  it("finds an agent by its home folder or its command on PATH", () => {
    mkdirSync(join(home, ".cursor"));
    onPath.add("codex");
    expect(detectAgents(env()).map((a) => a.id)).toEqual(["codex", "cursor"]);
  });

  it("finds nothing in an empty home", () => {
    expect(detectAgents(env())).toEqual([]);
  });
});

describe("hookCommand", () => {
  it("is the README's command, so a hook set up by hand and by init are the same", () => {
    expect(hookCommand("codex")).toBe("npx -y @xmu-labs/xkg@latest session-start --agent codex");
  });
});

describe("Codex", () => {
  it("writes the MCP server, the hook and the rules block into a fresh home", () => {
    setupAgent(agent("codex"), env());
    expect(file(".codex/config.toml")).toContain(
      '[mcp_servers.xkg]\ncommand = "npx"\nargs = ["-y", "@xmu-labs/xkg@latest", "serve-mcp"]\n',
    );
    expect(json(".codex/hooks.json")).toEqual({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: hookCommand("codex") }] }] },
    });
    expect(file(".codex/AGENTS.md")).toBe(RULES_BLOCK + "\n");
  });

  it("keeps the user's other servers and comments in config.toml", () => {
    const before = '# my settings\nmodel = "gpt-6"\n\n[mcp_servers.other]\ncommand = "other" # keep me\n';
    put(".codex/config.toml", before);
    setupAgent(agent("codex"), env());
    const after = file(".codex/config.toml");
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain("[mcp_servers.xkg]");
  });

  it("leaves an existing xkg server alone, even one with a key in it", () => {
    const before = '[mcp_servers.xkg]\ncommand = "npx"\nargs = ["-y", "@xmu-labs/xkg@latest", "serve-mcp", "--key", "k"]\n';
    put(".codex/config.toml", before);
    const steps = setupAgent(agent("codex"), env());
    expect(file(".codex/config.toml")).toBe(before);
    expect(steps.find((s) => s.part === "mcp")?.result).toBe("unchanged");
  });

  it.each([
    ["a quoted table name", "[mcp_servers.'xkg']\ncommand = \"npx\"\n"],
    ["a key under [mcp_servers]", "[mcp_servers]\nxkg = { command = \"npx\" }\n"],
    ["a dotted key", "mcp_servers.xkg.command = \"npx\"\n"],
  ])("finds an existing xkg server written as %s", (_, before) => {
    put(".codex/config.toml", before);
    const steps = setupAgent(agent("codex"), env());
    expect(file(".codex/config.toml")).toBe(before);
    expect(steps.find((s) => s.part === "mcp")?.result).toBe("unchanged");
    expect(inspectAgent(agent("codex"), env()).find((c) => c.part === "mcp")?.status).toBe("ok");
  });

  it("doesn't append a table after an inline mcp_servers table, which TOML can't extend", () => {
    const before = 'mcp_servers = { other = { command = "other" } }\n';
    put(".codex/config.toml", before);
    const mcp = setupAgent(agent("codex"), env()).find((s) => s.part === "mcp")!;
    expect(file(".codex/config.toml")).toBe(before);
    expect(mcp.result).toBe("manual");
    expect(mcp.note).toContain("[mcp_servers.xkg]");
  });

  it("ignores a commented-out xkg table", () => {
    put(".codex/config.toml", "# [mcp_servers.xkg]\n");
    expect(setupAgent(agent("codex"), env()).find((s) => s.part === "mcp")?.result).toBe("added");
  });

  it("changes nothing on a second run", () => {
    setupAgent(agent("codex"), env());
    const first = [file(".codex/config.toml"), file(".codex/hooks.json"), file(".codex/AGENTS.md")];
    const steps = setupAgent(agent("codex"), env());
    expect([file(".codex/config.toml"), file(".codex/hooks.json"), file(".codex/AGENTS.md")]).toEqual(first);
    expect(steps.every((s) => s.result === "unchanged")).toBe(true);
  });

  it("keeps an existing session-start hook as it is, so Codex doesn't ask to trust it again", () => {
    const own = { hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "npx -y @xmu-labs/xkg@1.8.0 session-start --agent codex" }] }] } };
    put(".codex/hooks.json", JSON.stringify(own));
    setupAgent(agent("codex"), env());
    expect(json(".codex/hooks.json")).toEqual(own);
  });

  it("adds its hook next to the user's other hooks", () => {
    put(".codex/hooks.json", JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }], Stop: [] } }));
    setupAgent(agent("codex"), env());
    const hooks = json(".codex/hooks.json").hooks;
    expect(hooks.Stop).toEqual([]);
    expect(hooks.SessionStart).toHaveLength(2);
    expect(hooks.SessionStart[0].hooks[0].command).toBe("echo hi");
  });
});

describe("Claude Code", () => {
  it("registers the server with the claude CLI at user scope, without a key", () => {
    onPath.add("claude");
    setupAgent(agent("claude"), env());
    expect(calls).toHaveLength(1);
    const [cmd, ...args] = calls[0]!;
    expect([cmd, ...args.slice(0, 5)]).toEqual(["claude", "mcp", "add-json", "-s", "user", "xkg"]);
    expect(JSON.parse(args[5]!)).toEqual({ type: "stdio", command: "npx", args: MCP_ARGS });
  });

  it("doesn't register again when ~/.claude.json already has xkg", () => {
    onPath.add("claude");
    put(".claude.json", JSON.stringify({ mcpServers: { xkg: { type: "http", url: "https://xkg.xmu.sh/api/mcp" } } }));
    const steps = setupAgent(agent("claude"), env());
    expect(calls).toEqual([]);
    expect(steps.find((s) => s.part === "mcp")?.result).toBe("unchanged");
  });

  it("prints the command when the claude CLI isn't on PATH", () => {
    mkdirSync(join(home, ".claude"));
    const steps = setupAgent(agent("claude"), env());
    const mcp = steps.find((s) => s.part === "mcp")!;
    expect(mcp.result).toBe("manual");
    expect(mcp.note).toContain("claude mcp add-json -s user xkg");
  });

  it("writes the hook into settings.json and keeps the user's settings", () => {
    put(".claude/settings.json", JSON.stringify({ model: "opus", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [] }] } }));
    setupAgent(agent("claude"), env());
    const s = json(".claude/settings.json");
    expect(s.model).toBe("opus");
    expect(s.hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [] }]);
    expect(s.hooks.SessionStart).toEqual([{ hooks: [{ type: "command", command: hookCommand("claude") }] }]);
  });

  it("replaces the older inbox-check hook, so a session doesn't get two offers", () => {
    const legacy = "npx -y @xmu-labs/xkg@latest inbox-check --key k --briefing";
    put(".claude/settings.json", JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: legacy }, { type: "command", command: "echo mine" }] }] } }));
    const hook = setupAgent(agent("claude"), env()).find((s) => s.part === "hook")!;
    const groups = json(".claude/settings.json").hooks.SessionStart;
    expect(groups).toEqual([
      { hooks: [{ type: "command", command: "echo mine" }] },
      { hooks: [{ type: "command", command: hookCommand("claude") }] },
    ]);
    expect(hook.note).toMatch(/inbox-check/);
  });

  it("removes the older inbox-check hook even when session-start is already there", () => {
    put(".claude/settings.json", JSON.stringify({ hooks: { SessionStart: [
      { hooks: [{ type: "command", command: "npx -y mnemos-capture@latest inbox-check --key k" }] },
      { hooks: [{ type: "command", command: hookCommand("claude") }] },
    ] } }));
    setupAgent(agent("claude"), env());
    expect(json(".claude/settings.json").hooks.SessionStart).toEqual([{ hooks: [{ type: "command", command: hookCommand("claude") }] }]);
  });

  it("warns in doctor when the older inbox-check hook runs next to session-start", () => {
    put(".claude/settings.json", JSON.stringify({ hooks: { SessionStart: [
      { hooks: [{ type: "command", command: "npx -y @xmu-labs/xkg@latest inbox-check --key k" }] },
      { hooks: [{ type: "command", command: hookCommand("claude") }] },
    ] } }));
    const hook = inspectAgent(agent("claude"), env()).find((c) => c.part === "hook")!;
    expect(hook.status).toBe("warn");
    expect(hook.fix).toContain("init");
  });

  it("adds the rules block under the user's own CLAUDE.md text", () => {
    put(".claude/CLAUDE.md", "# Me\n\nUse tabs.\n");
    setupAgent(agent("claude"), env());
    expect(file(".claude/CLAUDE.md")).toBe(`# Me\n\nUse tabs.\n\n${RULES_BLOCK}\n`);
  });
});

describe("Gemini CLI", () => {
  it("merges the server and the hook into settings.json", () => {
    put(".gemini/settings.json", JSON.stringify({ theme: "dark", mcpServers: { other: { command: "o" } } }));
    setupAgent(agent("gemini"), env());
    const s = json(".gemini/settings.json");
    expect(s.theme).toBe("dark");
    expect(s.mcpServers.other).toEqual({ command: "o" });
    expect(s.mcpServers.xkg).toEqual({ command: "npx", args: MCP_ARGS });
    expect(s.hooks.SessionStart).toEqual([{ hooks: [{ type: "command", command: hookCommand("gemini") }] }]);
    expect(file(".gemini/GEMINI.md")).toBe(RULES_BLOCK + "\n");
  });

  it("doesn't touch a settings.json it can't parse, and says what to add", () => {
    put(".gemini/settings.json", "{ // comment\n}");
    const steps = setupAgent(agent("gemini"), env());
    expect(file(".gemini/settings.json")).toBe("{ // comment\n}");
    const mcp = steps.find((s) => s.part === "mcp")!;
    expect(mcp.result).toBe("manual");
    expect(mcp.note).toContain("serve-mcp");
  });
});

describe("GitHub Copilot", () => {
  it("writes a local server, its own hook file (for Unix and Windows shells), and the instructions block", () => {
    setupAgent(agent("copilot"), env());
    expect(json(".copilot/mcp-config.json").mcpServers.xkg).toEqual({ type: "local", command: "npx", args: MCP_ARGS, tools: ["*"] });
    expect(json(".copilot/hooks/xkg.json")).toEqual({
      version: 1,
      hooks: { sessionStart: [{ type: "command", bash: hookCommand("copilot"), powershell: hookCommand("copilot") }] },
    });
    expect(file(".copilot/copilot-instructions.md")).toBe(RULES_BLOCK + "\n");
  });
});

describe("GitHub Copilot on Windows", () => {
  it("finds a hook that only has the Windows command", () => {
    mkdirSync(join(home, ".copilot", "hooks"), { recursive: true });
    writeFileSync(join(home, ".copilot", "hooks", "xkg.json"), JSON.stringify({ version: 1, hooks: { sessionStart: [{ type: "command", powershell: hookCommand("copilot") }] } }));
    expect(inspectAgent(agent("copilot"), env()).find((c) => c.part === "hook")?.status).toBe("ok");
  });
});

describe("Cursor", () => {
  it("writes the server and the hook; it has no user rules file", () => {
    setupAgent(agent("cursor"), env());
    expect(json(".cursor/mcp.json").mcpServers.xkg).toEqual({ command: "npx", args: MCP_ARGS });
    expect(json(".cursor/hooks.json")).toEqual({ version: 1, hooks: { sessionStart: [{ command: hookCommand("cursor") }] } });
    expect(existsSync(join(home, ".cursor", "AGENTS.md"))).toBe(false);
  });
});

describe("rules block", () => {
  it("replaces an older xkg block and keeps the text around it", () => {
    put(".gemini/GEMINI.md", "top\n\n<!-- xkg -->\nold words\n<!-- /xkg -->\n\nbottom\n");
    setupAgent(agent("gemini"), env());
    expect(file(".gemini/GEMINI.md")).toBe(`top\n\n${RULES_BLOCK}\n\nbottom\n`);
  });

  it("leaves a hand-written ## xkg section alone instead of adding a second one", () => {
    const before = "## xkg\n- At the start of a coding session, call the xkg `briefing` tool.\n";
    put(".codex/AGENTS.md", before);
    const steps = setupAgent(agent("codex"), env());
    expect(file(".codex/AGENTS.md")).toBe(before);
    expect(steps.find((s) => s.part === "rules")?.result).toBe("unchanged");
  });

  it("names the tools every agent should use", () => {
    expect(RULES_BLOCK).toMatch(/^<!-- xkg -->\n## xkg\n/);
    expect(RULES_BLOCK).toContain("`briefing`");
    expect(RULES_BLOCK).toContain("xkg-capture: <filename>");
    expect(RULES_BLOCK).toMatch(/\n<!-- \/xkg -->$/);
  });
});

describe("inspectAgent", () => {
  it("fails each missing part with the command that fixes it", () => {
    const checks = inspectAgent(agent("gemini"), env());
    expect(checks.map((c) => [c.part, c.status])).toEqual([["mcp", "fail"], ["hook", "fail"], ["rules", "fail"]]);
    expect(checks.every((c) => c.fix?.includes("xkg@latest init"))).toBe(true);
  });

  it("passes every part after setup", () => {
    for (const a of AGENTS) {
      onPath.add("claude");
      setupAgent(a, env());
      if (a.id === "claude") put(".claude.json", JSON.stringify({ mcpServers: { xkg: { command: "npx", args: MCP_ARGS } } }));
      const checks = inspectAgent(a, env());
      expect(checks.filter((c) => c.status === "fail"), a.id).toEqual([]);
    }
  });

  it("reminds Codex users to trust the hook once", () => {
    setupAgent(agent("codex"), env());
    const hook = inspectAgent(agent("codex"), env()).find((c) => c.part === "hook")!;
    expect(hook.status).toBe("ok");
    expect(hook.detail).toContain("/hooks");
  });

  // Regression: ISSUE-003 — a settings.json with comments (Gemini allows them) always failed,
  // even after the user added xkg by hand as init told them to
  // Found by /qa on 2026-10-30
  it("reads a settings.json with comments and trailing commas", () => {
    put(".gemini/settings.json", `{
  // my servers
  "mcpServers": { "xkg": { "command": "npx", "args": ["//not a comment"] }, },
  /* hooks */
  "hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": "${hookCommand("gemini")}" }] }] },
}`);
    const checks = inspectAgent(agent("gemini"), env());
    expect(checks.filter((c) => c.part !== "rules").map((c) => c.status)).toEqual(["ok", "ok"]);
  });

  it("tells the user to add xkg by hand when the file can't be rewritten", () => {
    put(".gemini/settings.json", "{ // comment\n}");
    const mcp = inspectAgent(agent("gemini"), env()).find((c) => c.part === "mcp")!;
    expect(mcp.status).toBe("fail");
    expect(mcp.fix).toContain('"mcpServers"');
  });

  it("fails a hook that runs session-start for a different agent", () => {
    put(".cursor/hooks.json", JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: hookCommand("claude") }] } }));
    const hook = inspectAgent(agent("cursor"), env()).find((c) => c.part === "hook")!;
    expect(hook.status).toBe("fail");
  });

  it("has no rules check for Cursor", () => {
    expect(inspectAgent(agent("cursor"), env()).map((c) => c.part)).toEqual(["mcp", "hook"]);
  });
});
