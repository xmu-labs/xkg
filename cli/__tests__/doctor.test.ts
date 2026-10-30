import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { runChecks, formatChecks, type DoctorDeps, type DoctorCheck } from "../doctor.js";
import { AGENTS, setupAgent, type AgentEnv } from "../setup-agents.js";
import { installGitHooks } from "../git-hook.js";

/**
 * `xkg doctor` reads, never writes: one line per check, and the command that
 * fixes each one that fails. Fixtures are a home dir per case and a real git repo.
 */

let home: string;
let repo: string;

function env(): AgentEnv {
  return { home, onPath: () => false, run: () => ({ ok: true, out: "" }) };
}

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    env: env(),
    key: "k",
    cwd: repo,
    currentVersion: "1.9.0",
    connect: async () => ({ ok: true }),
    latestVersion: async () => "1.9.0",
    inbox: async () => "2 capture(s) in inbox:",
    preview: async () => "",
    mapCachePath: join(home, ".xkg", "maps.json"),
    ...over,
  };
}

function find(checks: DoctorCheck[], name: string): DoctorCheck {
  const c = checks.find((x) => x.name === name);
  if (!c) throw new Error(`no check named ${name}: ${checks.map((x) => x.name).join(", ")}`);
  return c;
}

function git(...args: string[]) {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "xkg-doctor-home-"));
  repo = mkdtempSync(join(tmpdir(), "xkg-doctor-repo-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe("account checks", () => {
  it("fails without a key, says how to set it, and skips what needs one", async () => {
    const checks = await runChecks(deps({ key: undefined }));
    const key = find(checks, "API key");
    expect(key.status).toBe("fail");
    expect(key.fix).toContain("init --key");
    expect(checks.some((c) => c.name === "Server")).toBe(false);
  });

  it("fails when xkg rejects the key", async () => {
    const checks = await runChecks(deps({ connect: async () => ({ ok: false, reason: "xkg rejected the API key (HTTP 401)." }) }));
    expect(find(checks, "Server")).toMatchObject({ status: "fail", detail: expect.stringContaining("401") });
  });

  it("warns when a newer CLI is out", async () => {
    const checks = await runChecks(deps({ currentVersion: "1.8.0", latestVersion: async () => "1.9.0" }));
    expect(find(checks, "CLI version")).toMatchObject({ status: "warn", detail: expect.stringContaining("1.9.0") });
  });

  it("fails when the account has no knowledge repo", async () => {
    const checks = await runChecks(deps({ inbox: async () => "Knowledge repo not configured." }));
    expect(find(checks, "Knowledge repo")).toMatchObject({ status: "fail", fix: expect.stringContaining("xkg.xmu.sh") });
  });

  it("doesn't mistake a capture that says 'not configured' for a missing repo", async () => {
    const inbox = "1 capture(s) in inbox:\n\n1. Core idea: Handle services that are not configured without crashing.";
    expect(find(await runChecks(deps({ inbox: async () => inbox })), "Knowledge repo").status).toBe("ok");
  });

  it("passes the knowledge repo when the inbox reads", async () => {
    expect(find(await runChecks(deps()), "Knowledge repo").status).toBe("ok");
  });
});

describe("agent checks", () => {
  it("warns when no agent is installed", async () => {
    expect(find(await runChecks(deps()), "Agents").status).toBe("warn");
  });

  it("checks each detected agent: missing, then healthy", async () => {
    mkdirSync(join(home, ".gemini"));
    let checks = await runChecks(deps());
    expect(checks.filter((c) => c.section === "Gemini CLI").map((c) => c.status)).toEqual(["fail", "fail", "fail"]);

    setupAgent(AGENTS.find((a) => a.id === "gemini")!, env());
    checks = await runChecks(deps());
    expect(checks.filter((c) => c.section === "Gemini CLI").map((c) => c.status)).toEqual(["ok", "ok", "ok"]);
  });

  it("reports a partial setup part by part", async () => {
    mkdirSync(join(home, ".cursor"));
    writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { xkg: { command: "npx" } } }));
    const checks = (await runChecks(deps())).filter((c) => c.section === "Cursor");
    expect(checks.map((c) => [c.name, c.status])).toEqual([["MCP server", "ok"], ["Session-start hook", "fail"]]);
  });
});

describe("repo checks", () => {
  beforeEach(() => {
    git("init", "-q");
    git("remote", "add", "origin", "https://github.com/acme/app.git");
  });

  it("fails when the git hook isn't installed", async () => {
    expect(find(await runChecks(deps()), "Git hook")).toMatchObject({ status: "fail", fix: expect.stringContaining("setup-git-hook") });
  });

  it("passes a hook pinned to the latest version", async () => {
    installGitHooks(repo, "1.9.0");
    expect(find(await runChecks(deps()), "Git hook")).toMatchObject({ status: "ok", detail: expect.stringContaining("1.9.0") });
  });

  it("warns when the hook is pinned to an older version", async () => {
    installGitHooks(repo, "1.7.0");
    expect(find(await runChecks(deps()), "Git hook")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("1.7.0"),
      fix: expect.stringContaining("setup-git-hook"),
    });
  });

  it("warns about a hook line from before npx ran outside the repo", async () => {
    mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
    writeFileSync(
      join(repo, ".git", "hooks", "post-commit"),
      '#!/bin/sh\nxkg_sha=$(git rev-parse HEAD); npx -y @xmu-labs/xkg@1.9.0 post-commit --sha "$xkg_sha" >/dev/null 2>&1 & # xkg\n',
    );
    expect(find(await runChecks(deps()), "Git hook").status).toBe("warn");
  });

  it("fails the code map when it was never sent, and passes once it was", async () => {
    expect(find(await runChecks(deps()), "Code map")).toMatchObject({ status: "fail", fix: expect.stringContaining("xkg@latest map") });
    mkdirSync(join(home, ".xkg"));
    writeFileSync(join(home, ".xkg", "maps.json"), JSON.stringify({ repos: { "acme/app": { hash: "h", sentAt: Date.now() - 3600_000 } } }));
    expect(find(await runChecks(deps()), "Code map")).toMatchObject({ status: "ok", detail: expect.stringContaining("acme/app") });
  });

  it("warns when the code map is more than two days old", async () => {
    mkdirSync(join(home, ".xkg"));
    writeFileSync(join(home, ".xkg", "maps.json"), JSON.stringify({ repos: { "acme/app": { sentAt: Date.now() - 3 * 86400_000 } } }));
    expect(find(await runChecks(deps()), "Code map").status).toBe("warn");
  });

  it("skips repo checks outside a git repo", async () => {
    rmSync(join(repo, ".git"), { recursive: true, force: true });
    const checks = await runChecks(deps());
    expect(checks.some((c) => c.name === "Git hook")).toBe(false);
  });
});

describe("dry run", () => {
  it("shows what the agent would see at session start", async () => {
    const checks = await runChecks(deps({ preview: async () => "xkg: 2 new captures in the user's inbox." }));
    expect(find(checks, "Session start")).toMatchObject({ status: "ok", detail: expect.stringContaining("2 new captures") });
  });

  it("says when nothing is waiting", async () => {
    expect(find(await runChecks(deps()), "Session start").detail).toMatch(/nothing/i);
  });
});

describe("formatChecks", () => {
  it("prints one line per check with its mark and the fix under it", () => {
    const out = formatChecks([
      { section: "Account", name: "API key", status: "fail", detail: "No key", fix: "npx -y @xmu-labs/xkg@latest init --key KEY" },
      { section: "Account", name: "Server", status: "ok", detail: "Reached xkg" },
    ]);
    expect(out).toContain("Account");
    expect(out).toContain("✗ API key: No key");
    expect(out).toContain("    Fix: npx -y @xmu-labs/xkg@latest init --key KEY");
    expect(out).toContain("✓ Server: Reached xkg");
  });
});
