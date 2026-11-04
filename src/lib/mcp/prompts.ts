/**
 * MCP prompts. A connector client (claude.ai, ChatGPT, Codex cloud, any remote
 * MCP client) can't run the session-start hook, so it gets one prompt the user
 * picks: `briefing`, which asks for the same briefing the hook asks for
 * (cli/session-start.ts). No tool is added; prompts don't count toward the
 * tool list budget.
 */

import { repoName } from "@/lib/code-repos";

export interface PromptSpec {
  name: string;
  title?: string;
  description: string;
  arguments?: Array<{ name: string; description: string; required: boolean }>;
}

export interface PromptMessage {
  role: "user";
  content: { type: "text"; text: string };
}

export const PROMPTS: PromptSpec[] = [
  {
    name: "briefing",
    title: "Brief me",
    description: "Which of your xkg captures fit this repo, and any waiting for your coding agent. Use it at the start of a session when no hook runs.",
    arguments: [{ name: "repo", description: "owner/name of the repo you're in (optional; read from git when left out)", required: false }],
  },
];

function briefingText(repo: string | null): string {
  const scope = repo ? `with repo "${repo}", ` : "with repo set to the origin's owner/name, ";
  return (
    `Before starting the user's task, call the xkg \`briefing\` tool ${scope}this repo's name, branch and last few commit messages as project_context. ` +
    "If it starts with captures waiting, ask the user the question it gives. " +
    "Otherwise tell the user in one line which captures fit this repo and ask if they want to apply one. " +
    "Check each candidate against the code before suggesting where it applies; never name a file you have not opened. " +
    "With no repo (a chat), call `briefing` with no arguments and say what is waiting. Before checking where a capture applies, ask the user once which repo they're working in, then call `briefing` with repo set to it."
  );
}

/** The prompt's messages, or null for a name the server doesn't have. */
export function getPrompt(name: string, args: Record<string, unknown>): { description: string; messages: PromptMessage[] } | null {
  const spec = PROMPTS.find((p) => p.name === name);
  if (!spec) return null;
  const repo = typeof args.repo === "string" ? repoName(args.repo) : null;
  return { description: spec.description, messages: [{ role: "user", content: { type: "text", text: briefingText(repo) } }] };
}
