import { homedir, tmpdir } from "os";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const HOSTED_URL = "https://xkg.xmu.sh/api/mcp";
const CLAUDE_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Settings = Record<string, any>;
type HookGroup = { hooks?: HookEntry[] };
type HookEntry = { type: string; command: string };

/** The npm package new hooks run. Releases also publish it as `mnemos-capture`. */
const PACKAGE = "@xmu-labs/xkg";

/**
 * Matches hooks this CLI installed under either package name, with or without
 * a version: `npx -y @xmu-labs/xkg@latest inbox-check`,
 * `npx -y mnemos-capture@latest inbox-check`, and the legacy
 * `npx mnemos-capture inbox-check`.
 */
function isOurHook(cmd: string, subcommand: "inbox-check" | "vault-check"): boolean {
  // The package must be a whole shell word: `my-xkg` or `@acme/xkg` is someone else's.
  return new RegExp(`(?:^|\\s)(?:${PACKAGE}|mnemos-capture)(?:@[\\w.-]+)?\\s+${subcommand}\\b`).test(cmd);
}

function isXkgHook(cmd: string): boolean {
  return isOurHook(cmd, "inbox-check");
}

function isXkgPreToolHook(cmd: string): boolean {
  return isOurHook(cmd, "vault-check");
}

/** True when a hook already runs the current package at @latest — nothing to migrate. */
function isCurrentHook(cmd: string): boolean {
  return cmd.includes(`npx -y ${PACKAGE}@latest `);
}

function readSettings(): Settings {
  if (!existsSync(CLAUDE_SETTINGS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, "utf-8")) as Settings;
  } catch {
    return {};
  }
}

function writeSettings(settings: Settings): void {
  const dir = join(homedir(), ".claude");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

// ── Session state for vault deduplication ──

function sessionStateFile(): string {
  const sessionId = process.env["CLAUDE_SESSION_ID"] ?? new Date().toISOString().split("T")[0] ?? "default";
  return join(tmpdir(), `mnemos-vault-${sessionId}.json`);
}

function readSessionSurfaced(): string[] {
  try {
    const file = sessionStateFile();
    if (!existsSync(file)) return [];
    return JSON.parse(readFileSync(file, "utf-8")) as string[];
  } catch {
    return [];
  }
}

function appendSessionSurfaced(filenames: string[]): void {
  try {
    const file = sessionStateFile();
    const existing = readSessionSurfaced();
    const updated = [...new Set([...existing, ...filenames])];
    writeFileSync(file, JSON.stringify(updated));
  } catch {
    // best-effort
  }
}

// ── Stdin reader for hook context ──

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    setTimeout(() => resolve(data), 2000);
  });
}

export function setupHooks(
  apiKey: string,
  opts: { briefing?: boolean; silent?: boolean; skipIfExists?: boolean; vault?: boolean } = {},
): void {
  const settings = readSettings();
  const hooks = settings.hooks ?? {};
  const sessionStart: HookGroup[] = hooks.SessionStart ?? [];

  // Inspect any existing xkg hook so we can either skip, migrate, or replace
  let existingCmd: string | null = null;
  for (const group of sessionStart) {
    for (const h of group.hooks ?? []) {
      if (typeof h.command === "string" && isXkgHook(h.command)) {
        existingCmd = h.command;
        break;
      }
    }
    if (existingCmd) break;
  }

  // skipIfExists (serve-mcp auto-install): preserve user-configured hooks but
  // silently migrate hooks that pin a version or use the old package name.
  if (existingCmd && opts.skipIfExists) {
    if (isCurrentHook(existingCmd)) return;
    // Migration: preserve the existing --briefing flag when upgrading to @latest
    opts = { ...opts, briefing: existingCmd.includes("--briefing") };
  }

  const command = opts.briefing
    ? `npx -y ${PACKAGE}@latest inbox-check --key ${apiKey} --briefing`
    : `npx -y ${PACKAGE}@latest inbox-check --key ${apiKey}`;

  // Remove any existing xkg inbox-check hook (handles key rotation too)
  const filtered = sessionStart
    .map((group: HookGroup) => ({
      ...group,
      hooks: (group.hooks ?? []).filter(
        (h: HookEntry) => !(typeof h.command === "string" && isXkgHook(h.command)),
      ),
    }))
    .filter((group: HookGroup) => (group.hooks ?? []).length > 0);

  filtered.push({ hooks: [{ type: "command", command }] });

  settings.hooks = { ...hooks, SessionStart: filtered };
  writeSettings(settings);

  if (!opts.silent) {
    console.log("xkg inbox hook installed.");
    console.log(`Location: ${CLAUDE_SETTINGS_PATH}`);
    if (opts.briefing) {
      console.log("At the start of each Claude Code session you'll see a full project briefing.");
    } else {
      console.log("At the start of each Claude Code session you'll see your inbox count.");
    }
  }

  if (opts.vault) {
    setupPreToolHook(apiKey, { silent: opts.silent, skipIfExists: opts.skipIfExists });
  }
}

export function setupPreToolHook(
  apiKey: string,
  opts: { silent?: boolean; skipIfExists?: boolean } = {},
): void {
  const settings = readSettings();
  const hooks = settings.hooks ?? {};
  const preToolCall: HookGroup[] = hooks.PreToolCall ?? [];

  let existingCmd: string | null = null;
  for (const group of preToolCall) {
    for (const h of group.hooks ?? []) {
      if (typeof h.command === "string" && isXkgPreToolHook(h.command)) {
        existingCmd = h.command;
        break;
      }
    }
    if (existingCmd) break;
  }

  if (existingCmd && opts.skipIfExists) {
    if (isCurrentHook(existingCmd)) return;
  }

  const command = `npx -y ${PACKAGE}@latest vault-check --key ${apiKey}`;

  const filtered = preToolCall
    .map((group: HookGroup) => ({
      ...group,
      hooks: (group.hooks ?? []).filter(
        (h: HookEntry) => !(typeof h.command === "string" && isXkgPreToolHook(h.command)),
      ),
    }))
    .filter((group: HookGroup) => (group.hooks ?? []).length > 0);

  filtered.push({ hooks: [{ type: "command", command }] });

  settings.hooks = { ...hooks, PreToolCall: filtered };
  writeSettings(settings);

  if (!opts.silent) {
    console.log("xkg vault hook installed (PreToolCall).");
    console.log("Your knowledge vault will surface relevant captures as you edit files.");
  }
}

function run(cmd: string): string {
  return execSync(cmd, { timeout: 2000, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
}

function detectProjectContext(): string {
  const parts: string[] = [];

  // Repo name
  try {
    const remote = run("git remote get-url origin");
    const match = remote.match(/\/([^/]+?)(?:\.git)?$/);
    const repo = match?.[1] ?? run("git rev-parse --show-toplevel").split("/").pop();
    if (repo) parts.push(`Project: ${repo}`);
  } catch {
    const dir = process.cwd().split("/").pop();
    if (dir) parts.push(`Project: ${dir}`);
  }

  // Current branch
  try {
    const branch = run("git branch --show-current");
    if (branch) parts.push(`Branch: ${branch}`);
  } catch {}

  // Recent commits (last 5)
  try {
    const log = run("git log --oneline -5");
    if (log) parts.push(`Recent commits:\n${log}`);
  } catch {}

  // Local agent instructions may contain private maintainer notes; do not upload them.
  return parts.length > 0 ? parts.join("\n\n") : "current project";
}

export async function callMcp(
  apiKey: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
  timeoutMs = 15000,
): Promise<string | null> {
  const res = await fetch(HOSTED_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: toolName, arguments: toolArgs },
      id: 1,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) return null;
  const data = (await res.json()) as { result?: { content?: Array<{ text?: string }> } };
  return data.result?.content?.[0]?.text ?? null;
}

export async function vaultCheck(apiKey: string): Promise<void> {
  try {
    const inputJson = await readStdin();
    if (!inputJson.trim()) return;

    let hookData: { tool_name?: string; tool_input?: Record<string, unknown> };
    try {
      hookData = JSON.parse(inputJson) as typeof hookData;
    } catch {
      return;
    }

    // Only act on file-editing tool calls
    const editingTools = ["Edit", "Write", "MultiEdit"];
    if (!hookData.tool_name || !editingTools.includes(hookData.tool_name)) return;

    const filePath = (hookData.tool_input?.["file_path"] as string | undefined) ??
                     (hookData.tool_input?.["path"] as string | undefined);
    if (!filePath) return;

    const projectCtx = detectProjectContext();
    const activityContext = `Editing file: ${filePath}\nProject context:\n${projectCtx}`;
    const sessionSurfaced = readSessionSurfaced();

    const text = await callMcp(apiKey, "vault_scan", {
      activity_context: activityContext,
      session_surfaced: sessionSurfaced,
    }, 8000);

    if (!text?.trim()) return;

    // Track surfaced filenames to avoid repetition within the session
    const filenameMatches = text.match(/(?:inbox|applied|archived)\/[\w-]+\.md/g) ?? [];
    if (filenameMatches.length > 0) appendSessionSurfaced(filenameMatches);

    process.stdout.write(text.trim() + "\n");
  } catch {
    // Silent fail — never interrupt a tool call
  }
}

export async function inboxCheck(
  apiKey: string,
  opts: { briefing?: boolean } = {},
): Promise<void> {
  try {
    if (opts.briefing) {
      const projectContext = detectProjectContext();
      const text = await callMcp(apiKey, "briefing", { project_context: projectContext });
      if (!text?.trim()) return;

      // Parse JSON suggestions block (captured before the Markdown narrative)
      type SurfacedCapture = { filename: string; applyNow: boolean };
      const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
      let applyNow: SurfacedCapture[] = [];
      if (jsonMatch?.[1]) {
        try {
          const all = JSON.parse(jsonMatch[1]) as SurfacedCapture[];
          applyNow = all.filter((s) => s.applyNow);
        } catch {
          applyNow = [];
        }
      }

      // Strip the JSON block — display only the Markdown narrative
      const displayText = text.replace(/```json[\s\S]*?```\n?/, "").trim();
      process.stdout.write(displayText + "\n");

      if (applyNow.length > 0) {
        const filenames = applyNow.map((s) => `'${s.filename}'`).join(", ");
        process.stdout.write(
          `\n---\nxkg: ${applyNow.length} insight${applyNow.length === 1 ? "" : "s"} ready to apply now.\n` +
          `Run generate_plan with selected_captures: [${filenames}] to get a full implementation plan.\n`,
        );
      }
      return;
    }

    // Default: fast count via list_inbox (no LLM call)
    const text = await callMcp(apiKey, "list_inbox", {});
    if (!text) return;

    // list_inbox returns "N capture(s) in inbox:" or "Inbox is empty."
    const match = text.match(/^(\d+)\s+capture/);
    if (!match) return;

    const count = parseInt(match[1] as string, 10);
    if (count > 0) {
      process.stdout.write(
        `xkg: ${count} capture${count === 1 ? "" : "s"} in inbox — run list_inbox to review\n`,
      );
    }
  } catch {
    // Silent fail — never interrupt a session startup
  }
}
