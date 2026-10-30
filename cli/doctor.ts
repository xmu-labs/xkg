import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { execFileSync } from "child_process";
import { detectAgents, inspectAgent, type AgentEnv, type Part } from "./setup-agents.js";
import { currentRepo } from "./session-start.js";
import { isNewer } from "./version-check.js";
import type { MapCache } from "./code-map.js";

/**
 * `xkg doctor`: checks that xkg works for this account, in every coding agent
 * it finds and in the current repo, and names the command that fixes each
 * problem. Read-only. Everything that touches the network comes in through
 * DoctorDeps, so the checks run against fixtures in tests.
 */

export interface DoctorCheck {
  section: string;
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  fix?: string;
}

export interface DoctorDeps {
  env: AgentEnv;
  key?: string;
  cwd: string;
  currentVersion: string;
  connect: (key: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  latestVersion: () => Promise<string | null>;
  /** list_inbox's text, or null when the call failed. */
  inbox: (key: string) => Promise<string | null>;
  /** What `xkg session-start` prints in cwd (plain text), or "" when nothing waits. */
  preview: (key: string, cwd: string) => Promise<string>;
  mapCachePath: string;
}

const NPX = "npx -y @xmu-labs/xkg@latest";
const PART_NAMES: Record<Part, string> = { mcp: "MCP server", hook: "Session-start hook", rules: "Rules block" };
/** The code map is re-sent daily by the hooks; older than this means they aren't running. */
const STALE_MAP_MS = 2 * 24 * 60 * 60 * 1000;

export async function runChecks(deps: DoctorDeps): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const add = (section: string, name: string, status: DoctorCheck["status"], detail: string, fix?: string) =>
    checks.push({ section, name, status, detail, ...(fix ? { fix } : {}) });

  // ── Account ──
  const latest = await deps.latestVersion().catch(() => null);
  let reachable = false;
  if (!deps.key) {
    add("Account", "API key", "fail", "No key in ~/.xkg/config.json", `${NPX} init --key YOUR_API_KEY (your key is in Settings at https://xkg.xmu.sh)`);
  } else {
    add("Account", "API key", "ok", "Key in ~/.xkg/config.json");
    const conn = await deps.connect(deps.key);
    if (conn.ok) {
      reachable = true;
      add("Account", "Server", "ok", "Reached xkg with your key");
    } else {
      add("Account", "Server", "fail", conn.reason, `Copy a current key from Settings at https://xkg.xmu.sh, then run: ${NPX} init --key YOUR_API_KEY`);
    }
  }
  if (latest && isNewer(latest, deps.currentVersion)) {
    add("Account", "CLI version", "warn", `Running ${deps.currentVersion}; ${latest} is out`, `Run commands as ${NPX} …`);
  } else {
    add("Account", "CLI version", "ok", deps.currentVersion);
  }
  if (deps.key && reachable) {
    const inbox = await deps.inbox(deps.key).catch(() => null);
    if (inbox === null) add("Account", "Knowledge repo", "warn", "Couldn't read your inbox just now");
    else if (/not configured/i.test(inbox)) add("Account", "Knowledge repo", "fail", "Your account has no knowledge repo yet", "Finish setup at https://xkg.xmu.sh/onboard");
    else add("Account", "Knowledge repo", "ok", "Your inbox reads");
  }

  // ── Agents ──
  const agents = detectAgents(deps.env);
  if (agents.length === 0) {
    add("Agents", "Agents", "warn", "No coding agent found (Claude Code, Codex, Gemini CLI, GitHub Copilot, Cursor)");
  }
  for (const agent of agents) {
    for (const c of inspectAgent(agent, deps.env)) add(agent.name, PART_NAMES[c.part], c.status, c.detail, c.fix);
  }

  // ── This repo ──
  const hooksDir = gitPath(deps.cwd, "hooks");
  if (hooksDir) {
    checkGitHook(hooksDir, latest ?? deps.currentVersion, add);
    checkCodeMap(deps, add);
  }

  // ── Dry run ──
  if (deps.key && reachable) {
    const text = (await deps.preview(deps.key, deps.cwd).catch(() => "")).trim();
    add("Dry run", "Session start", "ok", text ? `Your agent would see:\n${indent(text)}` : "Nothing is waiting, so your agent sees nothing");
  }
  return checks;
}

function gitPath(cwd: string, path: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--git-path", path], { cwd, encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return resolve(cwd, out);
  } catch {
    return null;
  }
}

type Add = (section: string, name: string, status: DoctorCheck["status"], detail: string, fix?: string) => void;

function xkgLine(hooksDir: string, name: string): string | null {
  const path = join(hooksDir, name);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8").split("\n").find((l) => l.endsWith("# xkg")) ?? null;
}

function checkGitHook(hooksDir: string, latest: string, add: Add): void {
  const fix = `${NPX} setup-git-hook`;
  const line = xkgLine(hooksDir, "post-commit");
  if (!line) {
    add("This repo", "Git hook", "fail", "No xkg line in the post-commit hook, so commits that apply a capture aren't recorded", fix);
    return;
  }
  const pinned = line.match(/@xmu-labs\/xkg@(\S+)/)?.[1] ?? line.match(/mnemos-capture@(\S+)/)?.[1] ?? "latest";
  if (!line.includes("--prefix")) {
    add("This repo", "Git hook", "warn", `Installed by an older version (${pinned}); in a clone of xkg itself it can't run`, fix);
  } else if (pinned !== "latest" && isNewer(latest, pinned)) {
    add("This repo", "Git hook", "warn", `Runs version ${pinned}; ${latest} is out`, fix);
  } else if (!xkgLine(hooksDir, "post-merge") || !xkgLine(hooksDir, "post-checkout")) {
    add("This repo", "Git hook", "warn", "The code map isn't refreshed after pulls and branch switches", fix);
  } else {
    add("This repo", "Git hook", "ok", `Installed, runs version ${pinned}`);
  }
}

function checkCodeMap(deps: DoctorDeps, add: Add): void {
  const repo = currentRepo(deps.cwd);
  if (!repo) {
    add("This repo", "Code map", "warn", "This repo has no origin remote, so xkg can't tell which repo it is");
    return;
  }
  let cache: MapCache = {};
  try {
    cache = JSON.parse(readFileSync(deps.mapCachePath, "utf-8")) as MapCache;
  } catch {
    // No cache: never sent from this machine
  }
  const sentAt = cache.repos?.[repo]?.sentAt;
  const fix = `${NPX} map`;
  if (!sentAt) add("This repo", "Code map", "fail", `The code map of ${repo} was never sent from this machine`, fix);
  else if (Date.now() - sentAt > STALE_MAP_MS) add("This repo", "Code map", "warn", `${repo} last sent ${ago(sentAt)}`, fix);
  else add("This repo", "Code map", "ok", `${repo} sent ${ago(sentAt)}`);
}

function ago(at: number): string {
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

function indent(text: string): string {
  return text.split("\n").map((l) => `      ${l}`).join("\n");
}

const MARKS = { ok: "✓", warn: "!", fail: "✗" } as const;

export function formatChecks(checks: DoctorCheck[]): string {
  const lines: string[] = [];
  let section = "";
  for (const c of checks) {
    if (c.section !== section) {
      section = c.section;
      lines.push("", `  ${section}`);
    }
    lines.push(`  ${MARKS[c.status]} ${c.name}: ${c.detail}`);
    if (c.fix && c.status !== "ok") lines.push(`    Fix: ${c.fix}`);
  }
  return lines.join("\n") + "\n";
}
