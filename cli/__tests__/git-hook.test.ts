import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, mkdirSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

/**
 * The git post-commit hook links a commit to the captures it applied, with
 * any coding agent (or none): the agent adds an `xkg-capture:` trailer to the
 * commit message, and the hook reports it to xkg's apply_capture.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "xkg-git-hook-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

function commit(dir: string, file: string, message: string): string {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), `${Math.random()}\n`);
  git(dir, "add", "-A");
  // Bypass any hook this test installed: the tests call postCommit directly
  git(dir, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

describe("captureTrailers", () => {
  it("reads every xkg-capture trailer, once each", async () => {
    const { captureTrailers } = await import("../git-hook.js");
    const message = "Retry with backoff\n\nBody text.\n\nxkg-capture: 2026-10-01-backoff.md\nXkg-Capture: inbox/2026-10-02-jitter.md\nxkg-capture: 2026-10-01-backoff.md\n";
    expect(captureTrailers(message)).toEqual(["2026-10-01-backoff.md", "inbox/2026-10-02-jitter.md"]);
  });

  it("ignores a mention that is not a trailer line", async () => {
    const { captureTrailers } = await import("../git-hook.js");
    expect(captureTrailers("Explain the xkg-capture: trailer in docs")).toEqual([]);
  });
});

describe("installPostCommitHook", () => {
  let repo: string;
  beforeEach(() => { repo = makeRepo(); });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("creates an executable post-commit hook that runs xkg in the background", async () => {
    const { installPostCommitHook } = await import("../git-hook.js");
    const path = installPostCommitHook("k1", repo);
    expect(path).toBe(join(repo, ".git", "hooks", "post-commit"));
    const script = readFileSync(path, "utf-8");
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain("npx -y @xmu-labs/xkg@latest post-commit --key k1 >/dev/null 2>&1 &");
    expect(statSync(path).mode & 0o111).not.toBe(0);
  });

  it("keeps an existing hook's lines and replaces only its own line on reinstall", async () => {
    const { installPostCommitHook } = await import("../git-hook.js");
    const path = join(repo, ".git", "hooks", "post-commit");
    writeFileSync(path, "#!/bin/sh\necho mine\n");
    installPostCommitHook("old", repo);
    installPostCommitHook("new", repo);
    const lines = readFileSync(path, "utf-8").trimEnd().split("\n");
    expect(lines[0]).toBe("#!/bin/sh");
    expect(lines[1]).toBe("echo mine");
    expect(lines.filter((l) => l.includes("post-commit --key"))).toEqual([
      "npx -y @xmu-labs/xkg@latest post-commit --key new >/dev/null 2>&1 & # xkg",
    ]);
  });

  it("installs where core.hooksPath points", async () => {
    const { installPostCommitHook } = await import("../git-hook.js");
    git(repo, "config", "core.hooksPath", ".githooks");
    expect(installPostCommitHook("k", repo)).toBe(join(repo, ".githooks", "post-commit"));
  });
});

describe("postCommit", () => {
  let repo: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    repo = makeRepo();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ result: { content: [{ text: "ok" }] } }), { status: 200 })));
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    rmSync(repo, { recursive: true, force: true });
  });

  function calls(): Array<{ name: string; arguments: Record<string, unknown> }> {
    return fetchSpy.mock.calls.map((c: unknown[]) => (JSON.parse((c[1] as { body: string }).body) as { params: { name: string; arguments: Record<string, unknown> } }).params);
  }

  it("reports each trailer to apply_capture with the commit sha and changed files", async () => {
    const { postCommit } = await import("../git-hook.js");
    const sha = commit(repo, "src/retry.ts", "Retry with backoff\n\nxkg-capture: 2026-10-01-backoff.md\nxkg-capture: 2026-10-02-jitter.md");

    await postCommit("key", repo);

    expect(calls()).toEqual([
      { name: "apply_capture", arguments: { filename: "2026-10-01-backoff.md", commit_sha: sha, target_file: "src/retry.ts" } },
      { name: "apply_capture", arguments: { filename: "2026-10-02-jitter.md", commit_sha: sha, target_file: "src/retry.ts" } },
    ]);
  });

  it("does nothing for a commit without a trailer", async () => {
    const { postCommit } = await import("../git-hook.js");
    commit(repo, "a.ts", "Plain commit");
    await postCommit("key", repo);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never throws, so a commit is never disturbed", async () => {
    const { postCommit } = await import("../git-hook.js");
    commit(repo, "a.ts", "Fix\n\nxkg-capture: c.md");
    fetchSpy.mockRejectedValue(new Error("offline"));
    await expect(postCommit("key", repo)).resolves.toBeUndefined();
    await expect(postCommit("key", join(repo, "not-a-repo"))).resolves.toBeUndefined();
  });
});
