import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { execFileSync } from "child_process";
import { callMcp, initializeMcp } from "./hooks.js";
import { getCurrentVersion } from "./version-check.js";

/**
 * Links commits to the captures they apply, with any coding agent or none.
 * The commit message carries one `xkg-capture: <filename>` trailer per
 * capture; a git post-commit hook reports each one to apply_capture with the
 * commit sha. The server counts a capture and commit once, so an agent that
 * also calls apply_capture itself does not double count.
 */

const PACKAGE = "@xmu-labs/xkg";
const MARKER = "# xkg";
/** The MCP client name the hook's reports carry, so the server counts them by agent. */
export const HOOK_CLIENT = "xkg-git-hook";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** `xkg-capture` values from the commit message's trailer block only (as git parses it), once each. */
export function captureTrailers(message: string): string[] {
  let trailers: string;
  try {
    trailers = execFileSync("git", ["interpret-trailers", "--parse"], { input: message, encoding: "utf-8", timeout: 5000 });
  } catch {
    return [];
  }
  const found = [...trailers.matchAll(/^xkg-capture:[ \t]*(\S+)[ \t]*$/gim)].map((m) => m[1]!);
  return [...new Set(found)];
}

/**
 * Installs or updates xkg's line in the repo's post-commit hook and returns the hook's path.
 * The line holds no credential (the hooks directory may be tracked); the key comes from
 * `xkg config` at run time. It reads the sha before going to the background, so a quick
 * next commit can't be reported in its place. It runs the CLI version that installed it, so
 * a new release reaches a repo only when the hook is installed again.
 */
export function installPostCommitHook(cwd: string = process.cwd(), version: string = getCurrentVersion()): string {
  const hooksDir = resolve(cwd, git(cwd, "rev-parse", "--git-path", "hooks"));
  const path = join(hooksDir, "post-commit");
  const pin = version === "0.0.0" ? "latest" : version;
  const line = `xkg_sha=$(git rev-parse HEAD); npx -y ${PACKAGE}@${pin} post-commit --sha "$xkg_sha" >/dev/null 2>&1 & ${MARKER}`;

  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "#!/bin/sh\n";
  if (!/^#!\s*\S*\b(?:env\s+)?(?:sh|bash|zsh|dash|ksh)\b/.test(existing.split("\n")[0] ?? "")) {
    throw new Error(`${path} is not a shell script; add this line to it yourself:\n${line}`);
  }
  const kept = existing.split("\n").filter((l) => !l.endsWith(MARKER) || !l.includes(" post-commit "));
  const body = kept.join("\n").replace(/\n*$/, "\n");

  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(path, `${body}${line}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** Runs after each commit: reports every `xkg-capture:` trailer of `sha` to apply_capture. Never throws. */
export async function postCommit(apiKey: string, sha: string, cwd: string = process.cwd()): Promise<void> {
  try {
    const full = git(cwd, "rev-parse", "--verify", `${sha}^{commit}`);
    const trailers = captureTrailers(git(cwd, "log", "-1", "--format=%B", full));
    if (trailers.length === 0) return;

    const files = git(cwd, "diff-tree", "--root", "--no-commit-id", "--name-only", "-r", full).split("\n").filter(Boolean);
    const target = files.slice(0, 5).join(", ") + (files.length > 5 ? ` and ${files.length - 5} more` : "");

    // One session for all of this commit's reports. Without one they still count, as "unknown".
    const session = await initializeMcp(apiKey, HOOK_CLIENT, 10000)
      .then((res) => (res.ok ? res.headers.get("mcp-session-id") : null))
      .catch(() => null);
    for (const filename of trailers) {
      await callMcp(apiKey, "apply_capture", { filename, commit_sha: full, target_file: target }, 10000, session).catch(() => null);
    }
  } catch {
    // Never disturb a commit
  }
}

/** Checks that the hook can reach xkg with this key. Reports no capture. */
export async function checkHookConnection(apiKey: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  let res: Response;
  try {
    res = await initializeMcp(apiKey, HOOK_CLIENT, 10000);
  } catch (err) {
    return { ok: false, reason: `Could not reach xkg: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (res.status === 401) {
    return { ok: false, reason: `xkg rejected the API key (HTTP 401). Run setup-git-hook again with a current key.` };
  }
  if (!res.ok) return { ok: false, reason: `xkg answered HTTP ${res.status}.` };
  return { ok: true };
}
