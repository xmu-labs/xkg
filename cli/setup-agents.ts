import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

/**
 * What `xkg init` writes into each coding agent, and what `xkg doctor` checks:
 * the MCP server, the session-start hook and the rules block. Every agent gets
 * the same command and the same text; only the file each agent reads differs.
 *
 * The MCP entries carry no key: serve-mcp reads it from ~/.xkg/config.json.
 * Writers keep the user's other entries, never rewrite an xkg entry that is
 * already there (Codex trusts a hook by a hash of its definition), and leave a
 * file they can't parse untouched, saying what to add instead.
 */

export type AgentId = "claude" | "codex" | "gemini" | "copilot" | "cursor";
export type Part = "mcp" | "hook" | "rules";

export interface AgentEnv {
  home: string;
  onPath: (cmd: string) => boolean;
  /** Runs an agent's own CLI; used where the agent owns its config file (Claude Code). */
  run: (cmd: string, args: string[]) => { ok: boolean; out: string };
}

export interface Step {
  agent: AgentId;
  part: Part;
  file: string;
  result: "added" | "unchanged" | "manual";
  /** For "manual": what to add by hand, and why. */
  note?: string;
  undo?: string;
}

export interface Check {
  agent: AgentId;
  part: Part;
  status: "ok" | "warn" | "fail";
  detail: string;
  fix?: string;
}

export interface AgentSpec {
  id: AgentId;
  name: string;
  /** Folder under home whose presence means the agent is installed. */
  dir: string;
  /** CLI name whose presence on PATH means the agent is installed. */
  bin?: string;
  /** Files under home that setup may change, so init can back them up first. */
  files: string[];
  mcp: Writer;
  hook: Writer;
  rules?: string;
}

interface Writer {
  write(env: AgentEnv, id: AgentId): Step;
  check(env: AgentEnv, id: AgentId): Check;
}

const PACKAGE = "@xmu-labs/xkg";
const MCP_ARGS = ["-y", `${PACKAGE}@latest`, "serve-mcp"];
/** Names an xkg server was registered under over time. */
const SERVER_NAMES = ["xkg", "xmu", "mnemos"];
const INIT = `npx -y ${PACKAGE}@latest init`;

/** The command each agent's session-start hook runs, exactly as the README documents it. */
export function hookCommand(agent: AgentId): string {
  return `npx -y ${PACKAGE}@latest session-start --agent ${agent}`;
}

const START = "<!-- xkg -->";
const END = "<!-- /xkg -->";

/** The same standing instruction for every agent, in a block that a re-run replaces. */
export const RULES_BLOCK = [
  START,
  "## xkg",
  "- At the start of a coding session, call the xkg `briefing` tool with the repo name, branch, and last few commit messages. Check each capture it returns against the code before naming a file.",
  "- When the user shares something worth keeping, call `capture`.",
  "- When a commit uses a capture, add a line `xkg-capture: <filename>` to the commit message, then call `apply_capture` with the filename, the commit sha, the repo, and one line on why. If the user turns a capture down, call it with outcome `declined`, or `later` for not now.",
  END,
].join("\n");

// ── File helpers ──

function tilde(env: AgentEnv, path: string): string {
  return path.startsWith(env.home) ? `~${path.slice(env.home.length)}` : path;
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

type Json = Record<string, any>;

/** Parsed JSON object, {} for a missing file, null for one that isn't plain JSON. */
function readJson(path: string): Json | null {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Json) : null;
  } catch {
    return null;
  }
}

/** Drops line and block comments and trailing commas outside strings, as JSONC readers allow. */
function stripJsonc(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** Like readJson, but also reads JSON with comments. For checks only: init never rewrites such a file. */
function readJsonLoose(path: string): Json | null {
  const strict = readJson(path);
  if (strict) return strict;
  try {
    const parsed: unknown = JSON.parse(stripJsonc(readFileSync(path, "utf-8")));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Json) : null;
  } catch {
    return null;
  }
}

/** The fix for a missing entry: init, or by hand when init can't rewrite the file. */
function fixFor(file: string, snippet: string, env: AgentEnv): string {
  return readJson(file) ? INIT : `Add to ${tilde(env, file)} by hand (init leaves files with comments as they are): ${snippet}`;
}

function writeJson(path: string, data: Json): void {
  writeText(path, JSON.stringify(data, null, 2) + "\n");
}

function hasServer(servers: unknown): boolean {
  return !!servers && typeof servers === "object" && SERVER_NAMES.some((n) => n in (servers as Json));
}

// ── MCP writers ──

/** `mcpServers.xkg` in a JSON file (Gemini, Cursor, Copilot). */
function jsonServer(rel: string, entry: Json): Writer {
  const snippet = JSON.stringify({ mcpServers: { xkg: entry } });
  return {
    write(env, id) {
      const file = join(env.home, rel);
      const data = readJson(file);
      if (!data) return { agent: id, part: "mcp", file, result: "manual", note: `${tilde(env, file)} isn't plain JSON, so it was left as is. Add: ${snippet}` };
      if (hasServer(data.mcpServers)) return { agent: id, part: "mcp", file, result: "unchanged" };
      data.mcpServers = { ...(data.mcpServers ?? {}), xkg: entry };
      writeJson(file, data);
      return { agent: id, part: "mcp", file, result: "added", undo: `remove "xkg" from mcpServers in ${tilde(env, file)}` };
    },
    check(env, id) {
      const file = join(env.home, rel);
      return hasServer(readJsonLoose(file)?.mcpServers)
        ? { agent: id, part: "mcp", status: "ok", detail: `Registered in ${tilde(env, file)}` }
        : { agent: id, part: "mcp", status: "fail", detail: `No xkg MCP server in ${tilde(env, file)}`, fix: fixFor(file, snippet, env) };
    },
  };
}

const NAME = `(["']?)(?:${SERVER_NAMES.join("|")})\\1`;
const TABLE_HEADER = /^\s*\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$/;

/**
 * How config.toml holds MCP servers, read line by line (no TOML parser in the CLI):
 * whether an xkg server is already defined in any spelling, and whether
 * `mcp_servers` is an inline table, which a `[mcp_servers.xkg]` table can't extend.
 */
function codexServers(text: string): { hasXkg: boolean; inline: boolean } {
  let table = "";
  let hasXkg = false;
  let inline = false;
  for (const line of text.split("\n")) {
    if (/^\s*#/.test(line)) continue;
    const header = line.match(TABLE_HEADER);
    if (header) {
      table = header[1]!.replace(/\s+/g, "");
      if (new RegExp(`^mcp_servers\\.${NAME}(?:\\.|$)`).test(table)) hasXkg = true;
      continue;
    }
    if (table === "") {
      if (/^\s*mcp_servers\s*=/.test(line)) inline = true;
      if (new RegExp(`^\\s*mcp_servers\\s*\\.\\s*${NAME}\\s*[.=]`).test(line)) hasXkg = true;
    } else if (table === "mcp_servers" && new RegExp(`^\\s*${NAME}\\s*[.=]`).test(line)) {
      hasXkg = true;
    }
  }
  return { hasXkg, inline };
}

/** `[mcp_servers.xkg]` appended to Codex's config.toml as text, so the user's comments stay. */
const codexServer: Writer = {
  write(env, id) {
    const file = join(env.home, ".codex", "config.toml");
    const current = existsSync(file) ? readFileSync(file, "utf-8") : "";
    const servers = codexServers(current);
    if (servers.hasXkg) return { agent: id, part: "mcp", file, result: "unchanged" };
    const table = `[mcp_servers.xkg]\ncommand = "npx"\nargs = [${MCP_ARGS.map((a) => JSON.stringify(a)).join(", ")}]\n`;
    if (servers.inline) {
      return { agent: id, part: "mcp", file, result: "manual", note: `${tilde(env, file)} sets mcp_servers as an inline table, so it was left as is. Add xkg to it, or move it to tables and add:\n${table}` };
    }
    writeText(file, current ? `${current.replace(/\n*$/, "\n")}\n${table}` : table);
    return { agent: id, part: "mcp", file, result: "added", undo: `delete the [mcp_servers.xkg] table in ${tilde(env, file)}` };
  },
  check(env, id) {
    const file = join(env.home, ".codex", "config.toml");
    return existsSync(file) && codexServers(readFileSync(file, "utf-8")).hasXkg
      ? { agent: id, part: "mcp", status: "ok", detail: `Registered in ${tilde(env, file)}` }
      : { agent: id, part: "mcp", status: "fail", detail: `No [mcp_servers.xkg] in ${tilde(env, file)}`, fix: INIT };
  },
};

/** Claude Code owns ~/.claude.json, so it registers through its own CLI and is only read here. */
const claudeServer: Writer = {
  write(env, id) {
    const file = join(env.home, ".claude.json");
    const args = ["mcp", "add-json", "-s", "user", "xkg", JSON.stringify({ type: "stdio", command: "npx", args: MCP_ARGS })];
    if (hasServer(readJson(file)?.mcpServers)) return { agent: id, part: "mcp", file, result: "unchanged" };
    const command = `claude ${args.slice(0, 5).join(" ")} '${args[5]}'`;
    if (!env.onPath("claude")) return { agent: id, part: "mcp", file, result: "manual", note: `The claude CLI isn't on PATH. Run: ${command}` };
    const res = env.run("claude", args);
    if (!res.ok) return { agent: id, part: "mcp", file, result: "manual", note: `claude mcp add-json failed (${res.out.trim()}). Run: ${command}` };
    return { agent: id, part: "mcp", file, result: "added", undo: "claude mcp remove -s user xkg" };
  },
  check(env, id) {
    const file = join(env.home, ".claude.json");
    return hasServer(readJsonLoose(file)?.mcpServers)
      ? { agent: id, part: "mcp", status: "ok", detail: "Registered for all projects (user scope)" }
      : { agent: id, part: "mcp", status: "fail", detail: "xkg isn't registered at user scope (it may be in one project only)", fix: INIT };
  },
};

// ── Hook writers ──

/** True when `cmd` runs xkg session-start for `agent`, in any version. */
function isOurHook(cmd: unknown, agent: AgentId): boolean {
  return typeof cmd === "string" && /(?:@xmu-labs\/xkg|mnemos-capture|\bxkg)(?:@\S+)?\s+session-start\b/.test(cmd) && new RegExp(`--agent\\s+${agent}\\b`).test(cmd);
}

function anyXkgSessionStart(cmd: unknown): boolean {
  return typeof cmd === "string" && /(?:@xmu-labs\/xkg|mnemos-capture|\bxkg)(?:@\S+)?\s+session-start\b/.test(cmd);
}

/** Every command string in a hooks object, nested ({hooks:[{command}]}) or flat ({command} / {bash} / {powershell}). */
function commands(groups: unknown): unknown[] {
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((g: Json) => [g?.command, g?.bash, g?.powershell, ...(Array.isArray(g?.hooks) ? g.hooks.flatMap((h: Json) => [h?.command, h?.bash, h?.powershell]) : [])]);
}

interface HookShape {
  rel: string;
  event: string;
  /** The entry to append to hooks[event]. */
  entry: (cmd: string) => Json;
  /** Top-level fields a new file starts with. */
  base?: Json;
  trustNote?: string;
  /** Older xkg hooks this one replaces, so a session doesn't get two offers. */
  legacy?: RegExp;
}

/** Drops hook entries whose command matches `legacy`, and groups left empty. */
function withoutLegacy(groups: Json[], legacy: RegExp): Json[] {
  const old = (h: Json) => typeof h?.command === "string" && legacy.test(h.command);
  return groups
    .filter((g) => !old(g))
    .map((g) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((h: Json) => !old(h)) } : g))
    .filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
}

function jsonHook(shape: HookShape): Writer {
  return {
    write(env, id) {
      const file = join(env.home, shape.rel);
      const data = readJson(file);
      const entry = shape.entry(hookCommand(id));
      if (!data) {
        return { agent: id, part: "hook", file, result: "manual", note: `${tilde(env, file)} isn't plain JSON, so it was left as is. Add to hooks.${shape.event}: ${JSON.stringify(entry)}` };
      }
      const hooks: Json = data.hooks && typeof data.hooks === "object" ? data.hooks : {};
      const current: Json[] = Array.isArray(hooks[shape.event]) ? hooks[shape.event] : [];
      const kept = shape.legacy ? withoutLegacy(current, shape.legacy) : current;
      const replaced = kept.length !== current.length || JSON.stringify(kept) !== JSON.stringify(current);
      const present = commands(kept).some((c) => isOurHook(c, id));
      if (present && !replaced) return { agent: id, part: "hook", file, result: "unchanged" };
      const list = present ? kept : [...kept, entry];
      writeJson(file, { ...(existsSync(file) ? {} : shape.base), ...data, hooks: { ...hooks, [shape.event]: list } });
      const notes = [replaced ? "it replaces the older xkg inbox-check hook, so sessions don't get two offers" : "", shape.trustNote ?? ""].filter(Boolean);
      return {
        agent: id,
        part: "hook",
        file,
        result: "added",
        ...(notes.length ? { note: notes.join("; ") } : {}),
        undo: `remove the session-start hook from hooks.${shape.event} in ${tilde(env, file)}${replaced ? " (the inbox-check hook it replaced is in the backup)" : ""}`,
      };
    },
    check(env, id) {
      const file = join(env.home, shape.rel);
      const found = commands(readJsonLoose(file)?.hooks?.[shape.event]);
      if (found.some((c) => isOurHook(c, id))) {
        if (shape.legacy && found.some((c) => typeof c === "string" && shape.legacy!.test(c))) {
          return { agent: id, part: "hook", status: "warn", detail: `The older xkg inbox-check hook also runs in ${tilde(env, file)}, so sessions get two offers`, fix: INIT };
        }
        return { agent: id, part: "hook", status: "ok", detail: `In ${tilde(env, file)}${shape.trustNote ? `. ${shape.trustNote}` : ""}` };
      }
      if (found.some(anyXkgSessionStart)) {
        return { agent: id, part: "hook", status: "fail", detail: `The session-start hook in ${tilde(env, file)} isn't for --agent ${id}, so ${id} can't read its output`, fix: `Change it to: ${hookCommand(id)}` };
      }
      const snippet = JSON.stringify({ hooks: { [shape.event]: [shape.entry(hookCommand(id))] } });
      return { agent: id, part: "hook", status: "fail", detail: `No session-start hook in ${tilde(env, file)}`, fix: fixFor(file, snippet, env) };
    },
  };
}

const nested = (cmd: string) => ({ hooks: [{ type: "command", command: cmd }] });

// ── Rules ──

function blockRange(text: string): [number, number] | null {
  const start = text.indexOf(START);
  const end = text.indexOf(END, start);
  return start === -1 || end === -1 ? null : [start, end + END.length];
}

/** An `## xkg` heading the user wrote by hand, outside our markers. */
function hasOwnSection(text: string): boolean {
  return /^##\s+xkg\s*$/im.test(text);
}

function writeRules(env: AgentEnv, id: AgentId, rel: string): Step {
  const file = join(env.home, rel);
  const current = existsSync(file) ? readFileSync(file, "utf-8") : "";
  const range = blockRange(current);
  let next: string;
  if (range) {
    next = current.slice(0, range[0]) + RULES_BLOCK + current.slice(range[1]);
  } else if (hasOwnSection(current)) {
    return { agent: id, part: "rules", file, result: "unchanged", note: `${tilde(env, file)} already has an xkg section, so it was left as is` };
  } else {
    next = current.trim() ? `${current.replace(/\n*$/, "\n")}\n${RULES_BLOCK}\n` : `${RULES_BLOCK}\n`;
  }
  if (next === current) return { agent: id, part: "rules", file, result: "unchanged" };
  writeText(file, next);
  return { agent: id, part: "rules", file, result: "added", undo: `delete the lines from ${START} to ${END} in ${tilde(env, file)}` };
}

function checkRules(env: AgentEnv, id: AgentId, rel: string): Check {
  const file = join(env.home, rel);
  const text = existsSync(file) ? readFileSync(file, "utf-8") : "";
  if (blockRange(text) || hasOwnSection(text)) return { agent: id, part: "rules", status: "ok", detail: `In ${tilde(env, file)}` };
  return { agent: id, part: "rules", status: "fail", detail: `No xkg rules block in ${tilde(env, file)}`, fix: INIT };
}

// ── Agents ──

export const AGENTS: AgentSpec[] = [
  {
    id: "claude",
    name: "Claude Code",
    dir: ".claude",
    bin: "claude",
    files: [".claude.json", ".claude/settings.json", ".claude/CLAUDE.md"],
    mcp: claudeServer,
    hook: jsonHook({
      rel: ".claude/settings.json",
      event: "SessionStart",
      entry: nested,
      // What serve-mcp --key and setup-hooks installed before session-start existed
      legacy: /(?:^|\s)(?:@xmu-labs\/xkg|mnemos-capture)(?:@[\w.-]+)?\s+inbox-check\b/,
    }),
    rules: ".claude/CLAUDE.md",
  },
  {
    id: "codex",
    name: "Codex",
    dir: ".codex",
    bin: "codex",
    files: [".codex/config.toml", ".codex/hooks.json", ".codex/AGENTS.md"],
    mcp: codexServer,
    hook: jsonHook({
      rel: ".codex/hooks.json",
      event: "SessionStart",
      entry: nested,
      trustNote: "Codex runs it once you trust it: type /hooks in Codex",
    }),
    rules: ".codex/AGENTS.md",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    dir: ".gemini",
    bin: "gemini",
    files: [".gemini/settings.json", ".gemini/GEMINI.md"],
    mcp: jsonServer(".gemini/settings.json", { command: "npx", args: MCP_ARGS }),
    hook: jsonHook({ rel: ".gemini/settings.json", event: "SessionStart", entry: nested }),
    rules: ".gemini/GEMINI.md",
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    dir: ".copilot",
    bin: "copilot",
    files: [".copilot/mcp-config.json", ".copilot/hooks/xkg.json", ".copilot/copilot-instructions.md"],
    mcp: jsonServer(".copilot/mcp-config.json", { type: "local", command: "npx", args: MCP_ARGS, tools: ["*"] }),
    hook: jsonHook({ rel: ".copilot/hooks/xkg.json", event: "sessionStart", base: { version: 1 }, entry: (cmd) => ({ type: "command", bash: cmd, powershell: cmd }) }),
    rules: ".copilot/copilot-instructions.md",
  },
  {
    id: "cursor",
    name: "Cursor",
    dir: ".cursor",
    files: [".cursor/mcp.json", ".cursor/hooks.json"],
    mcp: jsonServer(".cursor/mcp.json", { command: "npx", args: MCP_ARGS }),
    // Cursor keeps User Rules in the app, not a file; its hook carries the ask.
    hook: jsonHook({ rel: ".cursor/hooks.json", event: "sessionStart", base: { version: 1 }, entry: (cmd) => ({ command: cmd }) }),
  },
];

export function detectAgents(env: AgentEnv): AgentSpec[] {
  return AGENTS.filter((a) => existsSync(join(env.home, a.dir)) || (a.bin !== undefined && env.onPath(a.bin)));
}

export function setupAgent(agent: AgentSpec, env: AgentEnv): Step[] {
  const steps = [agent.mcp.write(env, agent.id), agent.hook.write(env, agent.id)];
  if (agent.rules) steps.push(writeRules(env, agent.id, agent.rules));
  return steps;
}

export function inspectAgent(agent: AgentSpec, env: AgentEnv): Check[] {
  const checks = [agent.mcp.check(env, agent.id), agent.hook.check(env, agent.id)];
  if (agent.rules) checks.push(checkRules(env, agent.id, agent.rules));
  return checks;
}
