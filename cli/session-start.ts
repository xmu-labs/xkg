import { execFileSync } from "child_process";
import { callMcp, initializeMcp } from "./hooks.js";
import { repoFromRemote } from "./code-map.js";

/** The name this command's MCP session carries, so the server can tell where a session began. */
export const SESSION_START_CLIENT = "xkg-session-start";

/**
 * How each agent's SessionStart hook reads added context. Agents not listed
 * here get plain text, which Claude Code and Codex also accept.
 */
const FORMATS: Record<string, (text: string) => unknown> = {
  claude: hookSpecificOutput,
  codex: hookSpecificOutput,
  gemini: hookSpecificOutput,
  copilot: (text) => ({ additionalContext: text }),
  cursor: (text) => ({ additional_context: text }),
};

function hookSpecificOutput(text: string): unknown {
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } };
}

function message(count: number): string {
  const ask = count === 1
    ? "You have 1 new xkg capture. Want to see it and apply it here?"
    : `You have ${count} new xkg captures. Want to see them and apply one here?`;
  return (
    `xkg: ${count} new capture${count === 1 ? "" : "s"} in the user's inbox.\n` +
    `Before starting the user's task, ask them: "${ask}"\n` +
    "If they say yes, call the xkg `briefing` tool with this repo's name, branch and last few commit messages, " +
    "then check each candidate against the code before suggesting where it applies."
  );
}

/** `owner/name` of the repo at `cwd` from its origin remote, or null outside a repo or without an origin. */
export function currentRepo(cwd: string = process.cwd()): string | null {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf-8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
    return repoFromRemote(url);
  } catch {
    return null;
  }
}

/** What the server's briefing starts with when captures wait for the repo. */
const OFFER_PREFIX = "xkg: ";

/**
 * Runs from any agent's SessionStart hook. In a repo with captures waiting for
 * it (HANDOFFS.md), prints the server's offer as is, so the hook and a briefing
 * call give the same words. Otherwise counts new captures and, when there are
 * some, prints the question the agent should ask. Either way shaped for that
 * agent. Never fails or delays a session for long: on any error it prints nothing.
 */
export async function sessionStart(
  apiKey: string,
  opts: { agent?: string; timeoutMs?: number; repo?: string | null } = {},
): Promise<void> {
  // One limit for the whole command, so a hung server can't hold the session twice as long.
  const deadline = Date.now() + (opts.timeoutMs ?? 3000);
  const remaining = () => Math.max(1, deadline - Date.now());
  try {
    const session = await initializeMcp(apiKey, SESSION_START_CLIENT, remaining())
      .then((res) => (res.ok ? res.headers.get("mcp-session-id") : null))
      .catch(() => null);
    const format = opts.agent ? FORMATS[opts.agent] : undefined;
    const print = (body: string) => process.stdout.write((format ? JSON.stringify(format(body)) : body) + "\n");

    const repo = opts.repo === undefined ? currentRepo() : opts.repo;
    if (repo) {
      const offer = await callMcp(apiKey, "briefing", { repo }, remaining(), session).catch(() => null);
      if (offer?.startsWith(OFFER_PREFIX)) return void print(offer);
    }

    const text = await callMcp(apiKey, "list_inbox", {}, remaining(), session);
    const count = parseInt(text?.match(/^(\d+)\s+capture/)?.[1] ?? "0", 10);
    if (count <= 0) return;
    print(message(count));
  } catch {
    // Silent fail: never interrupt a session start
  }
}
