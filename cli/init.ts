import { copyFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { AGENTS, detectAgents, setupAgent, type AgentEnv, type AgentId, type Step } from "./setup-agents.js";

/**
 * `xkg init`: checks the key, shows what it will set up, asks once, then
 * writes each detected agent's MCP server, session-start hook and rules block
 * (setup-agents.ts) and, inside a repo, the git hooks. Backs up every file
 * first and ends by saying what changed and how to undo it. Every outside
 * effect comes in through InitDeps.
 */

export interface InitDeps {
  env: AgentEnv;
  /** From --key. */
  key?: string;
  /** From ~/.xkg/config.json. */
  storedKey?: string;
  yes: boolean;
  /** From --agents; all detected agents when unset. */
  only?: AgentId[];
  interactive: boolean;
  ask: (question: string) => Promise<string>;
  log: (line: string) => void;
  saveKey: (key: string) => void;
  connect: (key: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** `owner/name` of the repo in the working directory, or null outside one. */
  repo: string | null;
  /** The working directory is inside a git repo (it may have no origin remote, so no `repo`). */
  inGitRepo: boolean;
  installGitHooks: () => string[];
  syncMap: (key: string) => Promise<string>;
  backupDir: string;
}

const PART_NAMES = { mcp: "MCP server", hook: "session-start hook", rules: "rules block" } as const;

function tilde(home: string, path: string): string {
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export async function runInit(deps: InitDeps): Promise<{ ok: boolean; steps: Step[] }> {
  const { log } = deps;
  const home = deps.env.home;

  // ── Key ──
  let key = deps.key ?? deps.storedKey;
  if (!key && deps.interactive) {
    key = (await deps.ask("Paste your xkg API key (Settings at https://xkg.xmu.sh): ")).trim() || undefined;
  }
  if (!key) {
    log("No API key. Copy yours from Settings at https://xkg.xmu.sh, then run:");
    log("  npx -y @xmu-labs/xkg@latest init --key YOUR_API_KEY");
    return { ok: false, steps: [] };
  }
  const conn = await deps.connect(key);
  if (!conn.ok) {
    log(`Can't use this key: ${conn.reason}`);
    log("Nothing changed.");
    return { ok: false, steps: [] };
  }
  const isNewKey = key !== deps.storedKey;
  log(isNewKey ? "✓ Key works." : "✓ The key in ~/.xkg/config.json works.");
  const saveKey = () => {
    if (!isNewKey) return;
    deps.saveKey(key);
    log("✓ Key saved in ~/.xkg/config.json; agent configs get no key.");
  };

  // ── Plan ──
  const agents = detectAgents(deps.env).filter((a) => !deps.only || deps.only.includes(a.id));
  const keyOnly = agents.length === 0 && !deps.inGitRepo;
  if (keyOnly) {
    log("No coding agent found (Claude Code, Codex, Gemini CLI, GitHub Copilot, Cursor) and this isn't a git repo, so there's nothing else to set up.");
    if (!isNewKey) return { ok: true, steps: [] };
    log("");
    log("xkg will save this key in ~/.xkg/config.json, replacing the one there.");
  } else {
    log("");
    log("xkg will set up:");
  }
  for (const a of agents) {
    log(`  • ${a.name}: MCP server, session-start hook${a.rules ? `, rules block in ~/${a.rules}` : ""}`);
  }
  if (!keyOnly && agents.length === 0) log("  (no coding agent found: Claude Code, Codex, Gemini CLI, GitHub Copilot, Cursor)");
  if (deps.inGitRepo) log(`  • This repo${deps.repo ? ` (${deps.repo})` : ""}: git hooks that record applied captures and keep the code map fresh`);
  if (!keyOnly) log("It keeps your other settings, and leaves anything xkg already set up as it is.");
  if (agents.some((a) => a.id === "claude")) log("In Claude Code, the session-start hook replaces the older xkg inbox-check hook if you have one.");

  if (!deps.yes) {
    if (!deps.interactive) {
      log("");
      log("Run again with --yes to make these changes.");
      return { ok: false, steps: [] };
    }
    const answer = (await deps.ask("Go ahead? [Y/n] ")).trim().toLowerCase();
    if (answer && !answer.startsWith("y")) {
      log("Nothing changed.");
      return { ok: false, steps: [] };
    }
  }

  // ── Write ──
  saveKey();
  if (keyOnly) return { ok: true, steps: [] };
  let backedUp = 0;
  for (const a of agents) {
    for (const rel of a.files) {
      const src = join(home, rel);
      if (!existsSync(src)) continue;
      const dest = join(deps.backupDir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      backedUp++;
    }
  }

  log("");
  const steps: Step[] = [];
  for (const a of agents) {
    for (const step of setupAgent(a, deps.env)) {
      steps.push(step);
      const what = `${a.name}: ${PART_NAMES[step.part]}`;
      if (step.result === "added") log(`  ✓ ${what} added (${tilde(home, step.file)})`);
      else if (step.result === "unchanged") log(`  · ${what} already set up${step.note ? ` (${step.note})` : ""}`);
      else log(`  ! ${what} not written: ${step.note}`);
    }
  }

  if (deps.inGitRepo) {
    try {
      deps.installGitHooks();
      log(`  ✓ Git hooks installed in ${deps.repo ?? "this repo"}`);
      log(`  · ${deps.repo ? await deps.syncMap(key) : "Code map not sent: this repo has no origin remote"}`);
    } catch (err) {
      log(`  ! Git hooks not installed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Report ──
  const notes = steps.filter((s) => s.result === "added" && s.note).map((s) => s.note!);
  if (notes.length) {
    log("");
    for (const n of notes) log(`Next: ${n}.`);
  }
  const undo = steps.filter((s) => s.result === "added" && s.undo).map((s) => s.undo!);
  if (undo.length || deps.inGitRepo) {
    log("");
    log("To undo:");
    for (const u of undo) log(`  - ${u}`);
    if (deps.inGitRepo) log("  - delete the lines ending in `# xkg` in .git/hooks/post-commit, post-merge and post-checkout");
    if (backedUp) log(`Backups of the files as they were: ${tilde(home, deps.backupDir)}`);
  }
  return { ok: true, steps };
}

/** Agent names `--agents` accepts. */
export const AGENT_IDS = AGENTS.map((a) => a.id);
