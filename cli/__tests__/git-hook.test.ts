import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, mkdirSync, chmodSync, existsSync } from "fs";
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

  it("ignores an xkg-capture line in the body that prose follows", async () => {
    const { captureTrailers } = await import("../git-hook.js");
    const message = "Document trailers\n\nExample:\n\n```\nxkg-capture: 2026-10-01-example.md\n```\n\nThat is how it looks.\n";
    expect(captureTrailers(message)).toEqual([]);
  });
});

describe("installPostCommitHook", () => {
  let repo: string;
  beforeEach(() => { repo = makeRepo(); });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const LINE = 'xkg_sha=$(git rev-parse HEAD); npx -y @xmu-labs/xkg@1.7.0 post-commit --sha "$xkg_sha" >/dev/null 2>&1 & # xkg';

  it("creates an executable hook that records the commit sha before going to the background", async () => {
    const { installPostCommitHook } = await import("../git-hook.js");
    const path = installPostCommitHook(repo, "1.7.0");
    expect(path).toBe(join(repo, ".git", "hooks", "post-commit"));
    expect(readFileSync(path, "utf-8")).toBe(`#!/bin/sh\n${LINE}\n`);
    expect(statSync(path).mode & 0o111).not.toBe(0);
  });

  it("keeps an existing shell hook's lines and replaces only its own line, including an old one with a key", async () => {
    const { installPostCommitHook } = await import("../git-hook.js");
    const path = join(repo, ".git", "hooks", "post-commit");
    writeFileSync(path, "#!/bin/bash\necho mine\nnpx -y @xmu-labs/xkg@latest post-commit --key old >/dev/null 2>&1 & # xkg\n");
    installPostCommitHook(repo, "1.6.1");
    installPostCommitHook(repo, "1.7.0");
    expect(readFileSync(path, "utf-8")).toBe(`#!/bin/bash\necho mine\n${LINE}\n`);
  });

  it("pins the CLI version that installed it, so a release can't change every repo's hook at once", async () => {
    const { installPostCommitHook } = await import("../git-hook.js");
    const path = installPostCommitHook(repo, "1.7.0");
    expect(readFileSync(path, "utf-8")).toContain("npx -y @xmu-labs/xkg@1.7.0 post-commit");
    expect(readFileSync(path, "utf-8")).not.toContain("@latest");
  });

  it("falls back to @latest when its own version is unknown", async () => {
    const { installPostCommitHook } = await import("../git-hook.js");
    const path = installPostCommitHook(repo, "0.0.0");
    expect(readFileSync(path, "utf-8")).toContain("npx -y @xmu-labs/xkg@latest post-commit");
  });

  it("refuses to touch a hook written in another language", async () => {
    const { installPostCommitHook } = await import("../git-hook.js");
    const path = join(repo, ".git", "hooks", "post-commit");
    const python = "#!/usr/bin/env python3\nprint('mine')\n";
    writeFileSync(path, python);
    expect(() => installPostCommitHook(repo)).toThrow(/not a shell script/);
    expect(readFileSync(path, "utf-8")).toBe(python);
  });

  it("installs where core.hooksPath points, with no credential in the file", async () => {
    const { installPostCommitHook } = await import("../git-hook.js");
    git(repo, "config", "core.hooksPath", ".githooks");
    const path = installPostCommitHook(repo);
    expect(path).toBe(join(repo, ".githooks", "post-commit"));
    expect(readFileSync(path, "utf-8")).not.toMatch(/--key/);
  });
});

describe("postCommit", () => {
  let repo: string;
  let home: string;
  const realHome = process.env["HOME"];
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    repo = makeRepo();
    // A repo with an origin syncs its code map, which caches under HOME
    home = mkdtempSync(join(tmpdir(), "xkg-hook-home-"));
    process.env["HOME"] = home;
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ result: { content: [{ text: "ok" }] } }), { status: 200 })));
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    process.env["HOME"] = realHome;
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  type Sent = { method: string; params: { name: string; arguments: Record<string, unknown>; clientInfo?: { name: string } } };
  function sent(): Array<{ url: unknown; body: Sent; session: string | undefined }> {
    return fetchSpy.mock.calls.map((c: unknown[]) => {
      const init = c[1] as { body: string; headers: Record<string, string> };
      return { url: c[0], body: JSON.parse(init.body) as Sent, session: init.headers["Mcp-Session-Id"] };
    });
  }
  function calls(): Array<{ name: string; arguments: Record<string, unknown> }> {
    return sent().filter((s) => s.body.method === "tools/call").map((s) => s.body.params);
  }

  it("reports each trailer to apply_capture with the commit sha and changed files", async () => {
    const { postCommit } = await import("../git-hook.js");
    const sha = commit(repo, "src/retry.ts", "Retry with backoff\n\nxkg-capture: 2026-10-01-backoff.md\nxkg-capture: 2026-10-02-jitter.md");
    commit(repo, "src/later.ts", "A later commit\n\nxkg-capture: 2026-10-03-other.md");

    // The hook passes the sha it saw, even if HEAD has moved on since
    await postCommit("key", sha, repo);

    expect(calls()).toEqual([
      { name: "apply_capture", arguments: { filename: "2026-10-01-backoff.md", commit_sha: sha, target_file: "src/retry.ts", files: ["src/retry.ts"] } },
      { name: "apply_capture", arguments: { filename: "2026-10-02-jitter.md", commit_sha: sha, target_file: "src/retry.ts", files: ["src/retry.ts"] } },
    ]);
  });

  it("names itself xkg-git-hook in one session, so the server counts these applies by agent", async () => {
    const { postCommit } = await import("../git-hook.js");
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ result: { content: [{ text: "ok" }] } }), { status: 200, headers: { "mcp-session-id": "hook-session" } })));
    const sha = commit(repo, "a.ts", "Fix\n\nxkg-capture: a.md\nxkg-capture: b.md");

    await postCommit("key", sha, repo);

    expect(sent().map((s) => [s.body.method, s.body.params.clientInfo?.name ?? s.body.params.name, s.session])).toEqual([
      ["initialize", "xkg-git-hook", undefined],
      ["tools/call", "apply_capture", "hook-session"],
      ["tools/call", "apply_capture", "hook-session"],
    ]);
  });

  it("still reports when the session can't be opened", async () => {
    const { postCommit } = await import("../git-hook.js");
    fetchSpy.mockImplementationOnce(() => Promise.resolve(new Response("nope", { status: 500 })));
    const sha = commit(repo, "a.ts", "Fix\n\nxkg-capture: a.md");
    await postCommit("key", sha, repo);
    expect(calls()).toEqual([{ name: "apply_capture", arguments: { filename: "a.md", commit_sha: sha, target_file: "a.ts", files: ["a.ts"] } }]);
  });

  // protects: AC11, the hook's report closes the handoff in this repo; fails_when: the repo or the changed files are left out; no_claim: the server side (handoff-outcomes tests)
  it("names the repo and every changed file, up to 20", async () => {
    const { postCommit } = await import("../git-hook.js");
    git(repo, "remote", "add", "origin", "git@github.com:Acme/App.git");
    for (let i = 0; i < 22; i++) writeFileSync(join(repo, `f${String(i).padStart(2, "0")}.ts`), "x\n");
    const sha = commit(repo, "src/a.ts", "Fix\n\nxkg-capture: a.md");
    await postCommit("key", sha, repo);
    const args = calls()[0]!.arguments;
    expect(args.repo).toBe("Acme/App");
    expect(args.files).toHaveLength(20);
    expect(args.target_file).toBe("f00.ts, f01.ts, f02.ts, f03.ts, f04.ts and 18 more");
  });

  // protects: AC12, a plain `git revert` of an applied commit is reported, with no agent; fails_when: the revert isn't sent, names the revert's own sha, or is sent as an apply; no_claim: how fast the network answers (the hook runs in the background)
  it("reports a revert of a commit with a trailer as reverted", async () => {
    const { postCommit } = await import("../git-hook.js");
    git(repo, "remote", "add", "origin", "https://github.com/acme/app.git");
    commit(repo, "base.ts", "Base");
    const applied = commit(repo, "src/retry.ts", "Retry with backoff\n\nxkg-capture: 2026-10-01-backoff.md");
    git(repo, "-c", "core.hooksPath=/dev/null", "revert", "--no-edit", applied);
    const revert = git(repo, "rev-parse", "HEAD");
    await postCommit("key", revert, repo);
    expect(calls()).toEqual([
      { name: "apply_capture", arguments: { filename: "2026-10-01-backoff.md", commit_sha: applied, outcome: "reverted", repo: "acme/app" } },
    ]);
  });

  // protects: only reverts of applied commits are reported; fails_when: a revert of a plain commit sends anything; no_claim: none
  it("ignores a revert of a commit without a trailer", async () => {
    const { postCommit } = await import("../git-hook.js");
    commit(repo, "base.ts", "Base");
    const plain = commit(repo, "a.ts", "Plain");
    git(repo, "-c", "core.hooksPath=/dev/null", "revert", "--no-edit", plain);
    await postCommit("key", git(repo, "rev-parse", "HEAD"), repo);
    expect(calls()).toEqual([]);
  });

  // protects: a revert message that names a commit this clone doesn't have never stops the commit's own reports; fails_when: it throws or drops the trailer report; no_claim: none
  it("still reports a commit's trailers when its revert line names an unknown commit", async () => {
    const { postCommit } = await import("../git-hook.js");
    const sha = commit(repo, "a.ts", "Redo\n\nThis reverts commit 0123456789abcdef0123456789abcdef01234567.\n\nxkg-capture: a.md");
    await expect(postCommit("key", sha, repo)).resolves.toBeUndefined();
    expect(calls().map((c) => [c.arguments.filename, c.arguments.outcome])).toEqual([["a.md", undefined]]);
  });

  it("does nothing for a commit without a trailer", async () => {
    const { postCommit } = await import("../git-hook.js");
    const sha = commit(repo, "a.ts", "Plain commit");
    await postCommit("key", sha, repo);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // protects: the map follows the code after each commit, and an apply's new files are in the map before the server keeps only mapped files; fails_when: a commit without a trailer skips the sync, or the apply is reported before the sync; no_claim: the hash gate (code-map tests)
  it("syncs the code map before reporting, even for a commit without a trailer", async () => {
    const { postCommit } = await import("../git-hook.js");
    const home = mkdtempSync(join(tmpdir(), "xkg-home-"));
    const origHome = process.env["HOME"];
    process.env["HOME"] = home;
    try {
      git(repo, "remote", "add", "origin", "git@github.com:acme/widgets.git");
      const plain = commit(repo, "src/a.ts", "Plain commit");
      await postCommit("key", plain, repo);
      expect(sent().map((s) => String(s.url))).toEqual(["https://xkg.xmu.sh/api/code-map"]);

      const applied = commit(repo, "src/b.ts", "Fix\n\nxkg-capture: a.md");
      await postCommit("key", applied, repo);
      expect(sent().slice(1).map((s) => s.body.method ?? String(s.url))).toEqual(["https://xkg.xmu.sh/api/code-map", "initialize", "tools/call"]);
    } finally {
      process.env["HOME"] = origHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("never throws, so a commit is never disturbed", async () => {
    const { postCommit } = await import("../git-hook.js");
    const sha = commit(repo, "a.ts", "Fix\n\nxkg-capture: c.md");
    fetchSpy.mockRejectedValue(new Error("offline"));
    await expect(postCommit("key", sha, repo)).resolves.toBeUndefined();
    await expect(postCommit("key", "not-a-sha", repo)).resolves.toBeUndefined();
  });
});

describe("map sync hooks (any agent, or plain git)", () => {
  let repo: string;
  let bin: string;
  let log: string;
  beforeEach(() => {
    repo = makeRepo();
    bin = mkdtempSync(join(tmpdir(), "xkg-fake-npx-"));
    log = join(bin, "calls.log");
    // A stand-in npx that records what the hooks ask it to run
    writeFileSync(join(bin, "npx"), `#!/bin/sh\necho "$*" >> "${log}"\n`);
    chmodSync(join(bin, "npx"), 0o755);
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });

  const env = () => ({ ...process.env, PATH: `${bin}:${process.env["PATH"]}` });
  const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8", env: env() }).trim();
  async function calls(count: number): Promise<string[]> {
    // The hooks run in the background, so wait for their lines to land
    for (let t = 0; t < 100; t++) {
      const lines = existsSync(log) ? readFileSync(log, "utf-8").split("\n").filter(Boolean) : [];
      if (lines.length >= count) return lines;
      await new Promise((r) => setTimeout(r, 20));
    }
    return existsSync(log) ? readFileSync(log, "utf-8").split("\n").filter(Boolean) : [];
  }

  // protects: every agent (or none) keeps the map fresh the same way; fails_when: a commit, pull or branch switch made with plain git does not reach the sync; no_claim: what the sync sends (code-map tests)
  it("runs the hash-gated sync after a plain git commit, branch switch and pull", async () => {
    const { installGitHooks } = await import("../git-hook.js");
    installGitHooks(repo, "1.8.0");

    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    run(repo, "add", "-A");
    run(repo, "commit", "-q", "-m", "First");
    const sha = run(repo, "rev-parse", "HEAD");
    expect(await calls(1)).toEqual([`-y @xmu-labs/xkg@1.8.0 post-commit --sha ${sha}`]);

    run(repo, "checkout", "-q", "-b", "feature");
    expect((await calls(2))[1]).toBe("-y @xmu-labs/xkg@1.8.0 sync-map");

    const clone = mkdtempSync(join(tmpdir(), "xkg-clone-"));
    try {
      execFileSync("git", ["clone", "-q", repo, clone], { encoding: "utf-8" });
      installGitHooks(clone, "1.8.0");
      writeFileSync(join(repo, "b.ts"), "export const b = 1;\n");
      execFileSync("git", ["add", "-A"], { cwd: repo });
      execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", "Second"], { cwd: repo });
      run(clone, "-c", "pull.rebase=false", "pull", "-q", "origin", "feature");
      expect((await calls(3))[2]).toBe("-y @xmu-labs/xkg@1.8.0 sync-map");
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it("skips a checkout of files that doesn't switch branches", async () => {
    const { installGitHooks } = await import("../git-hook.js");
    commit(repo, "a.ts", "First");
    installGitHooks(repo, "1.8.0");
    writeFileSync(join(repo, "a.ts"), "changed\n");
    run(repo, "checkout", "--", "a.ts");
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(log)).toBe(false);
  });

  it("installs each hook once, keeping the user's own lines", async () => {
    const { installGitHooks } = await import("../git-hook.js");
    const merge = join(repo, ".git", "hooks", "post-merge");
    writeFileSync(merge, "#!/bin/sh\necho mine\n");
    installGitHooks(repo, "1.7.0");
    const paths = installGitHooks(repo, "1.8.0");
    expect(paths).toEqual(["post-commit", "post-merge", "post-checkout"].map((h) => join(repo, ".git", "hooks", h)));
    expect(readFileSync(merge, "utf-8")).toBe("#!/bin/sh\necho mine\nnpx -y @xmu-labs/xkg@1.8.0 sync-map >/dev/null 2>&1 & # xkg\n");
    expect(readFileSync(join(repo, ".git", "hooks", "post-checkout"), "utf-8")).toBe(
      '#!/bin/sh\n[ "$3" = "1" ] && npx -y @xmu-labs/xkg@1.8.0 sync-map >/dev/null 2>&1 & # xkg\n');
  });

  // protects: D3, a handoff spec the agent writes in .xkg/ is never committed; fails_when: git would track .xkg/handoffs/*.md, or the line is added twice or replaces the user's own; no_claim: agents that commit with --force
  it("keeps .xkg/ out of git, once, next to the user's own excludes", async () => {
    const { installGitHooks } = await import("../git-hook.js");
    const exclude = join(repo, ".git", "info", "exclude");
    writeFileSync(exclude, "*.log\n");
    installGitHooks(repo, "1.8.0");
    installGitHooks(repo, "1.8.0");
    expect(readFileSync(exclude, "utf-8")).toBe("*.log\n.xkg/\n");
    expect(run(repo, "check-ignore", ".xkg/handoffs/2026-10-29-llm-memory.md")).toBe(".xkg/handoffs/2026-10-29-llm-memory.md");
  });
});

describe("checkHookConnection", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => fetchSpy.mockRestore());

  it("succeeds when xkg accepts the key, without reporting any capture", async () => {
    const { checkHookConnection } = await import("../git-hook.js");
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200 }));

    expect(await checkHookConnection("key")).toEqual({ ok: true });
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as { body: string }).body) as { method: string };
    expect(body.method).toBe("initialize");
  });

  it("says when the key is rejected", async () => {
    const { checkHookConnection } = await import("../git-hook.js");
    fetchSpy.mockResolvedValue(new Response("{}", { status: 401 }));
    expect(await checkHookConnection("bad")).toEqual({ ok: false, reason: "xkg rejected the API key (HTTP 401). Run setup-git-hook again with a current key." });
  });

  it("says when xkg can't be reached", async () => {
    const { checkHookConnection } = await import("../git-hook.js");
    fetchSpy.mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
    expect(await checkHookConnection("key")).toEqual({ ok: false, reason: "Could not reach xkg: getaddrinfo ENOTFOUND" });
  });

  it("says when xkg answers with an error", async () => {
    const { checkHookConnection } = await import("../git-hook.js");
    fetchSpy.mockResolvedValue(new Response("<html>", { status: 502 }));
    expect(await checkHookConnection("key")).toEqual({ ok: false, reason: "xkg answered HTTP 502." });
  });
});
