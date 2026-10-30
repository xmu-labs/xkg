import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runInit, type InitDeps } from "../init.js";
import { hookCommand } from "../setup-agents.js";

/**
 * `xkg init`: one command that checks the key, shows what it will change,
 * asks once, writes each agent's setup and the repo's git hooks, then says
 * what changed and how to undo it. Every outside effect is a dep.
 */

let home: string;
let out: string[];
let saved: string[];
let asked: string[];
let answers: string[];
let gitInstalls: number;

function deps(over: Partial<InitDeps> = {}): InitDeps {
  return {
    env: { home, onPath: () => false, run: () => ({ ok: true, out: "" }) },
    key: "k",
    storedKey: undefined,
    yes: false,
    interactive: true,
    ask: async (q) => {
      asked.push(q);
      return answers.shift() ?? "";
    },
    log: (line) => out.push(line),
    saveKey: (k) => saved.push(k),
    connect: async () => ({ ok: true }),
    repo: null,
    installGitHooks: () => {
      gitInstalls++;
      return ["/r/.git/hooks/post-commit"];
    },
    syncMap: async () => "Synced acme/app: 12 files",
    backupDir: join(home, ".xkg", "backups", "t"),
    ...over,
  };
}

const text = () => out.join("\n");

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "xkg-init-"));
  out = [];
  saved = [];
  asked = [];
  answers = [];
  gitInstalls = 0;
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("key", () => {
  it("checks a new key and saves it", async () => {
    const res = await runInit(deps({ yes: true }));
    expect(res.ok).toBe(true);
    expect(saved).toEqual(["k"]);
  });

  it("doesn't save a key that xkg rejects, and changes nothing", async () => {
    mkdirSync(join(home, ".cursor"));
    const res = await runInit(deps({ yes: true, connect: async () => ({ ok: false, reason: "xkg rejected the API key (HTTP 401)." }) }));
    expect(res.ok).toBe(false);
    expect(saved).toEqual([]);
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
    expect(text()).toContain("401");
  });

  it("reuses the stored key without saving it again", async () => {
    await runInit(deps({ key: undefined, storedKey: "stored", yes: true }));
    expect(saved).toEqual([]);
  });

  it("asks for a key when there is none", async () => {
    answers = ["pasted", "y"];
    await runInit(deps({ key: undefined }));
    expect(asked[0]).toMatch(/API key/);
    expect(saved).toEqual(["pasted"]);
  });

  it("stops without a key when it can't ask", async () => {
    const res = await runInit(deps({ key: undefined, interactive: false }));
    expect(res.ok).toBe(false);
    expect(text()).toContain("--key");
  });
});

describe("asking once", () => {
  beforeEach(() => mkdirSync(join(home, ".cursor")));

  it("lists the agents it found and asks once before writing", async () => {
    answers = ["y"];
    await runInit(deps());
    expect(asked).toHaveLength(1);
    expect(text()).toContain("Cursor");
    expect(JSON.parse(readFileSync(join(home, ".cursor", "hooks.json"), "utf-8")).hooks.sessionStart[0].command).toBe(hookCommand("cursor"));
  });

  it("changes nothing when the user says no", async () => {
    answers = ["n"];
    const res = await runInit(deps());
    expect(res.ok).toBe(false);
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
    expect(text()).toMatch(/nothing changed/i);
  });

  it("doesn't ask with --yes", async () => {
    await runInit(deps({ yes: true }));
    expect(asked).toEqual([]);
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(true);
  });

  it("without a terminal, shows the plan and asks for --yes instead of writing", async () => {
    const res = await runInit(deps({ interactive: false }));
    expect(res.ok).toBe(false);
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
    expect(text()).toContain("--yes");
  });

  it("sets up only the agents named with --agents", async () => {
    mkdirSync(join(home, ".gemini"));
    await runInit(deps({ yes: true, only: ["gemini"] }));
    expect(existsSync(join(home, ".gemini", "settings.json"))).toBe(true);
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
  });
});

describe("what it writes and reports", () => {
  it("backs up each file before changing it", async () => {
    mkdirSync(join(home, ".cursor"));
    writeFileSync(join(home, ".cursor", "mcp.json"), '{"mcpServers":{"other":{}}}');
    await runInit(deps({ yes: true }));
    expect(readFileSync(join(home, ".xkg", "backups", "t", ".cursor", "mcp.json"), "utf-8")).toBe('{"mcpServers":{"other":{}}}');
    expect(text()).toContain(join(home, ".xkg", "backups", "t").replace(home, "~"));
  });

  it("prints each change and how to undo it", async () => {
    mkdirSync(join(home, ".cursor"));
    await runInit(deps({ yes: true }));
    expect(text()).toContain("~/.cursor/mcp.json");
    expect(text()).toMatch(/undo/i);
  });

  it("tells Codex users to trust the hook once", async () => {
    mkdirSync(join(home, ".codex"));
    await runInit(deps({ yes: true }));
    expect(text()).toContain("/hooks");
  });

  it("installs the git hooks and sends the code map in a repo", async () => {
    await runInit(deps({ yes: true, repo: "acme/app" }));
    expect(gitInstalls).toBe(1);
    expect(text()).toContain("Synced acme/app");
  });

  it("skips the git hooks outside a repo", async () => {
    await runInit(deps({ yes: true }));
    expect(gitInstalls).toBe(0);
  });

  it("says when there is nothing to set up", async () => {
    const res = await runInit(deps({ yes: true }));
    expect(res.ok).toBe(true);
    expect(text()).toMatch(/no coding agent/i);
  });
});
