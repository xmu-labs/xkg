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

  type Sent = { method: string; params: { name: string; arguments: Record<string, unknown>; clientInfo?: { name: string } } };
  function sent(): Array<{ body: Sent; session: string | undefined }> {
    return fetchSpy.mock.calls.map((c: unknown[]) => {
      const init = c[1] as { body: string; headers: Record<string, string> };
      return { body: JSON.parse(init.body) as Sent, session: init.headers["Mcp-Session-Id"] };
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
      { name: "apply_capture", arguments: { filename: "2026-10-01-backoff.md", commit_sha: sha, target_file: "src/retry.ts" } },
      { name: "apply_capture", arguments: { filename: "2026-10-02-jitter.md", commit_sha: sha, target_file: "src/retry.ts" } },
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
    expect(calls()).toEqual([{ name: "apply_capture", arguments: { filename: "a.md", commit_sha: sha, target_file: "a.ts" } }]);
  });

  it("does nothing for a commit without a trailer", async () => {
    const { postCommit } = await import("../git-hook.js");
    const sha = commit(repo, "a.ts", "Plain commit");
    await postCommit("key", sha, repo);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never throws, so a commit is never disturbed", async () => {
    const { postCommit } = await import("../git-hook.js");
    const sha = commit(repo, "a.ts", "Fix\n\nxkg-capture: c.md");
    fetchSpy.mockRejectedValue(new Error("offline"));
    await expect(postCommit("key", sha, repo)).resolves.toBeUndefined();
    await expect(postCommit("key", "not-a-sha", repo)).resolves.toBeUndefined();
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
