/**
 * xkg agent — runs a saved plan, or a handoff spec, with the user's own coding agent.
 *
 * Drives whatever AI assistant the user configured (`xkg config set agent ...`)
 * to implement a generated plan in an isolated git worktree. xkg owns the
 * harness-independent parts: fetching the plan, the worktree, and reporting the
 * Verification Checklist. The assistant is a black box — model-agnostic by design.
 *
 * With --spec, the plan is a spec the user's agent wrote in this repo
 * (.xkg/handoffs/), read from disk; nothing is fetched from xkg.
 */

import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { writeFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { callMcp } from "./hooks.js";
import { readConfig } from "./config.js";

// ── Pure helpers (exported for testing) ──

/** Pull the Verification Checklist items out of a plan's Markdown. */
export function parseChecklist(planText: string): string[] {
  const section = planText.match(/##\s*Verification Checklist\s*\n([\s\S]*?)(?=\n##\s|$)/i);
  if (!section?.[1]) return [];
  return section[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^- \[[ x]\]/i.test(l))
    .map((l) => l.replace(/^- \[[ x]\]\s*/i, ""));
}

/** Build a unique, sortable branch name for an agent run. */
export function buildAgentBranch(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, 19);
  return `xkg/agent-${stamp}`;
}

/**
 * A new empty folder for the run's worktree. Unique per run: the branch name
 * only has seconds, and the temp folder is shared by every repo on the machine.
 */
export function newWorktreePath(branch: string): string {
  return mkdtempSync(join(tmpdir(), `${branch.replace(/\//g, "-")}-`));
}

/** Where the agent run drops the plan inside the worktree. Never committed — see excludePlanFiles. */
export const PLAN_FILE = "XKG_PLAN.md";

/** Plan filenames written by earlier releases; still excluded so an old worktree can't leak one. */
const LEGACY_PLAN_FILES = ["MNEMOS_PLAN.md"] as const;

/** The instruction handed to the assistant. The plan file is the real contract. */
export const AGENT_PROMPT =
  `Implement the plan in ${PLAN_FILE} in this repository. ` +
  "Follow the Codebase Mapping table exactly — change only the files it lists. " +
  "For each step apply the thinking effort named in its Effort column " +
  "(low = quick/mechanical, medium = careful, high = deep reasoning). " +
  "When finished, make sure every item in the Verification Checklist is satisfied. " +
  `${PLAN_FILE} is private: never commit, push, or copy it into another file.`;

/** The instruction for a handoff spec (--spec). The spec is the contract. */
export const SPEC_PROMPT =
  `Apply the handoff spec in ${PLAN_FILE} to this repository. ` +
  "Change only the files in its Files and changes table, and nothing it lists under Not doing. " +
  "When finished, make sure every item in its Verification Checklist is satisfied. " +
  'In each commit message, add the line "xkg-capture: <filename>" with the filename from the spec\'s capture field. ' +
  `${PLAN_FILE} is private: never commit, push, or copy it into another file.`;

/** A spec the user's agent wrote in this repo. Throws when it can't be read or is empty. */
export function readSpec(path: string, cwd: string = process.cwd()): string {
  const text = readFileSync(resolve(cwd, path), "utf-8");
  if (!text.trim()) throw new Error(`${path} is empty.`);
  return text;
}

/**
 * Return the exclude-file contents with every plan filename present, or null if
 * nothing needs adding. Pure so the matching can be tested without a repo.
 */
export function withPlanExcludes(current: string): string | null {
  const lines = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = [PLAN_FILE, ...LEGACY_PLAN_FILES].filter((f) => !lines.has(f) && !lines.has(`/${f}`));
  if (missing.length === 0) return null;
  const sep = current === "" || current.endsWith("\n") ? "" : "\n";
  return `${current}${sep}${missing.join("\n")}\n`;
}

/**
 * Keep plan files out of git for this repository and all its worktrees.
 *
 * Asks git for the exclude path instead of assuming `<root>/.git/info/exclude`:
 * in a linked worktree or a submodule `.git` is a file, so the assumed path does
 * not exist and the plan would be silently committed by the agent's `git add`.
 * Throws rather than continuing unprotected — a plan can carry private context.
 */
export function excludePlanFiles(worktreePath: string): void {
  const excludePath = resolve(worktreePath, run("git rev-parse --git-path info/exclude", worktreePath));
  mkdirSync(dirname(excludePath), { recursive: true });
  const current = existsSync(excludePath) ? readFileSync(excludePath, "utf-8") : "";
  const next = withPlanExcludes(current);
  if (next !== null) writeFileSync(excludePath, next);
  try {
    run(`git check-ignore -q ${PLAN_FILE}`, worktreePath);
  } catch {
    throw new Error(`git would track ${PLAN_FILE} (exclude file: ${excludePath})`);
  }
}

// ── Orchestrator ──

function localSpec(path: string): { file: string; text: string } {
  try {
    return { file: path, text: readSpec(path) };
  } catch (err) {
    console.error(`Could not read spec: ${path}`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/**
 * A plan saved in plans/ of the knowledge repo (by versions before handoffs),
 * read with read_capture. The listed tools can't list a folder, so the plan
 * is named.
 */
export async function savedPlan(apiKey: string, plan: string | undefined): Promise<{ file: string; text: string }> {
  if (!plan) {
    console.error("Name the plan: xkg agent --plan FILE (a file in plans/ of your knowledge repo).");
    console.error("For a handoff spec your agent wrote, use: xkg agent --spec PATH");
    process.exit(1);
  }
  const file = plan.replace(/^plans\//, "");
  const text = await callMcp(apiKey, "read_capture", { filename: `plans/${file}` }, 15000);
  if (!text || !text.trim() || text.startsWith("File not found:")) {
    console.error(`Could not read plan: ${file}`);
    process.exit(1);
  }
  return { file, text };
}

function run(cmd: string, cwd?: string): string {
  return execSync(cmd, { cwd, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
}

export async function runAgent(apiKey: string, opts: { plan?: string; spec?: string } = {}): Promise<void> {
  const cfg = readConfig();
  if (!cfg.agent) {
    console.error("No agent configured. Tell xkg which AI worker to drive:\n");
    console.error('  xkg config set agent "claude -p"               # Claude Code');
    console.error('  xkg config set agent "codex exec"              # Codex');
    console.error('  xkg config set agent "aider --yes --message"   # Aider');
    process.exit(1);
  }

  // 1. Resolve the plan — a local spec or a saved plan by name
  const { file: planFile, text: planText } = opts.spec ? localSpec(opts.spec) : await savedPlan(apiKey, opts.plan);

  // 2. Must be inside a git repo
  let repoRoot: string;
  try {
    repoRoot = run("git rev-parse --show-toplevel");
  } catch {
    console.error("xkg agent must be run inside a git repository.");
    process.exit(1);
    return;
  }

  // 3. Isolated worktree on a fresh branch
  const branch = buildAgentBranch();
  const worktreePath = newWorktreePath(branch);
  console.log(`Creating isolated worktree on branch ${branch}...`);
  run(`git worktree add -b ${branch} "${worktreePath}"`, repoRoot);

  // 4. Keep git from tracking the plan (local exclude, not committed), then drop it in.
  //    Exclude first: if that fails, the plan is never written where git can see it.
  try {
    excludePlanFiles(worktreePath);
  } catch (err) {
    console.error(`Could not keep ${PLAN_FILE} out of git, so xkg agent stopped before writing it.`);
    console.error(err instanceof Error ? err.message : String(err));
    console.error(`The empty worktree is at ${worktreePath}.`);
    process.exit(1);
  }
  writeFileSync(join(worktreePath, PLAN_FILE), planText);

  // 5. Hand off to the user's assistant, running inside the worktree
  console.log(`Launching: ${cfg.agent}\n`);
  try {
    execSync(`${cfg.agent} ${JSON.stringify(opts.spec ? SPEC_PROMPT : AGENT_PROMPT)}`, { cwd: worktreePath, stdio: "inherit" });
  } catch {
    console.error("\nThe agent exited with an error. The worktree is preserved for inspection.");
  }

  // 6. Report — branch + the plan's own checklist as the review gate
  const checklist = parseChecklist(planText);
  console.log(`\n${"─".repeat(60)}`);
  console.log(`xkg agent finished. ${opts.spec ? "Spec" : "Plan"}: ${planFile}`);
  console.log(`Branch:   ${branch}`);
  console.log(`Worktree: ${worktreePath}`);
  if (checklist.length > 0) {
    console.log(`\nVerify before merging:`);
    for (const item of checklist) console.log(`  [ ] ${item}`);
  }
  console.log(`\nReview the branch, then merge. Clean up the worktree with:`);
  console.log(`  git worktree remove "${worktreePath}"`);
}
