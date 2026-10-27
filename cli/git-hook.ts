import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { execFileSync } from "child_process";
import { callMcp } from "./hooks.js";

/**
 * Links commits to the captures they apply, with any coding agent or none.
 * The commit message carries one `xkg-capture: <filename>` trailer per
 * capture; a git post-commit hook reports each one to apply_capture with the
 * commit sha. The server counts a capture and commit once, so an agent that
 * also calls apply_capture itself does not double count.
 */

const PACKAGE = "@xmu-labs/xkg";
const MARKER = "# xkg";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
}

export function captureTrailers(message: string): string[] {
  const found = [...message.matchAll(/^xkg-capture:[ \t]*(\S+)[ \t]*$/gim)].map((m) => m[1]!);
  return [...new Set(found)];
}

/** Installs or updates xkg's line in the repo's post-commit hook and returns the hook's path. */
export function installPostCommitHook(apiKey: string, cwd: string = process.cwd()): string {
  const hooksDir = resolve(cwd, git(cwd, "rev-parse", "--git-path", "hooks"));
  const path = join(hooksDir, "post-commit");
  // Backgrounded so a commit never waits on the network
  const line = `npx -y ${PACKAGE}@latest post-commit --key ${apiKey} >/dev/null 2>&1 & ${MARKER}`;

  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "#!/bin/sh\n";
  const kept = existing.split("\n").filter((l) => !l.endsWith(MARKER) || !l.includes(" post-commit "));
  const body = kept.join("\n").replace(/\n*$/, "\n");

  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(path, `${body}${line}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** Runs after each commit: reports every `xkg-capture:` trailer to apply_capture. Never throws. */
export async function postCommit(apiKey: string, cwd: string = process.cwd()): Promise<void> {
  try {
    const sha = git(cwd, "rev-parse", "HEAD");
    const trailers = captureTrailers(git(cwd, "log", "-1", "--format=%B", sha));
    if (trailers.length === 0) return;

    const files = git(cwd, "diff-tree", "--root", "--no-commit-id", "--name-only", "-r", sha).split("\n").filter(Boolean);
    const target = files.slice(0, 5).join(", ") + (files.length > 5 ? ` and ${files.length - 5} more` : "");

    for (const filename of trailers) {
      await callMcp(apiKey, "apply_capture", { filename, commit_sha: sha, target_file: target }, 10000).catch(() => null);
    }
  } catch {
    // Never disturb a commit
  }
}
