import { callMcp, initializeMcp } from "./hooks.js";

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

/**
 * Runs from any agent's SessionStart hook. Counts new captures and, when there
 * are some, prints the question the agent should ask, shaped for that agent.
 * Never fails or delays a session for long: on any error it prints nothing.
 */
export async function sessionStart(
  apiKey: string,
  opts: { agent?: string; timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  try {
    const session = await initializeMcp(apiKey, SESSION_START_CLIENT, timeoutMs)
      .then((res) => (res.ok ? res.headers.get("mcp-session-id") : null))
      .catch(() => null);
    const text = await callMcp(apiKey, "list_inbox", {}, timeoutMs, session);
    const count = parseInt(text?.match(/^(\d+)\s+capture/)?.[1] ?? "0", 10);
    if (count <= 0) return;

    const format = opts.agent ? FORMATS[opts.agent] : undefined;
    const body = message(count);
    process.stdout.write((format ? JSON.stringify(format(body)) : body) + "\n");
  } catch {
    // Silent fail: never interrupt a session start
  }
}
