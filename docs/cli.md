# xkg CLI and tools

**What's here:** every CLI command, and the tools your AI agent can call.
**Most people only need:** `init` to set up and `doctor` to check. See [Connect your AI](connect.md).

## Run it

There's nothing to install. Run any command with npx:

```bash
npx -y @xmu-labs/xkg@latest <command>
```

The binary is `xkg`.

## Commands

### Setup

| Command | What it does |
| --- | --- |
| `init [--key YOUR_API_KEY] [--yes] [--agents NAMES]` | Signs you in through the browser (or uses `--key`), then sets up xkg in every coding agent it finds and the git hooks in this repo. See [Connect your AI](connect.md#coding-agents-one-command) |
| `doctor [--json]` | Checks the key, server, knowledge repo, each agent, and this repo, with the fix for each problem. Changes nothing |
| `config set key YOUR_API_KEY` | Stores the key that `serve-mcp`, `session-start`, the git hooks, `map`, and `agent` use, in `~/.xkg/config.json` |
| `config set agent "claude -p"` | Sets which assistant `xkg agent` runs |

### Running and hooks

| Command | What it does |
| --- | --- |
| `npx -y @xmu-labs/xkg@latest` | Opens the hosted app |
| `serve-mcp [--key YOUR_API_KEY]` | Runs the local MCP server. Without `--key`, it uses the key in `~/.xkg/config.json` |
| `session-start [--agent NAME]` | For an agent's session-start hook: offers captures waiting for this repo, else has the agent brief on new captures before your task. `NAME` is `claude`, `codex`, `gemini`, `copilot`, or `cursor`; without it, the output is plain text. See [the session-start hook](connect.md#offer-new-captures-when-a-session-starts) |
| `setup-git-hook --key YOUR_API_KEY` | In a repo: records commits with an `xkg-capture: <filename>` line, and keeps the repo's code map up to date after commits, pulls, and branch switches. Works with any coding agent. The key is stored in `~/.xkg/config.json`, not in the hooks. Setup checks that the hook can reach xkg and sends the map once |
| `map [--key YOUR_API_KEY]` | In a repo: sends its code map now (file paths, exported names and signatures, opening comment lines; never code) |
| `setup-hooks --key YOUR_API_KEY [--no-briefing] [--vault]` | Installs Claude Code hooks. The session hook briefs by default (one LLM call on your key at session start); `--no-briefing` counts the inbox instead |

The git hooks run the CLI version that installed them. After a new release, run `setup-git-hook` again in each repo to update them.

### Applying captures

| Command | What it does |
| --- | --- |
| `agent --spec PATH` | Applies a handoff spec your agent wrote (`.xkg/handoffs/<capture>.md`) in a separate git worktree. Reads it from disk; no key needed |
| `agent --key YOUR_API_KEY --plan FILE` | Applies a plan saved in `plans/` by older versions, in a separate worktree |

### Debugging

| Command | What it does |
| --- | --- |
| `inbox-check --key YOUR_API_KEY [--briefing]` | Tests the session hook |
| `vault-check --key YOUR_API_KEY` | Tests the vault hook |
| `help` | Shows help |

What changed in each version: [GitHub Releases](https://github.com/xmu-labs/xkg/releases).

## Tools your agent can call

You don't need to remember these. Ask in plain language: "save this", "what do I have on payments?", "brief me for this repo".

| Tool | What it does |
| --- | --- |
| `capture` | Saves new knowledge from pasted text or a URL |
| `briefing` | **In a chat app** (no arguments): how many captures wait in your inbox, the newest few (each marked if it was handed off, with its repo and state), and which repos have handoffs waiting. It tells your AI to ask once which repo you're in before checking where a capture fits. **At session start in a repo:** captures that may fit the repo, for the agent to check against the code, plus your rules and any handoffs waiting there (found from `repo`, or from the `Project:` line of `project_context`). **Mid-task**, with `task` (and optional `files`): the captures that fit what the agent is doing now |
| `search` | Finds captures by words, tag, status (`inbox`, `applied`, `archived`), or date, or lists them all. A capture handed off to a repo is marked with the repo and its state |
| `read_capture` | Reads a capture in full (or `RULES.md`). A capture handed off to a repo ends with the repo and its state |
| `apply_capture` | Marks a capture as applied, with the commit and why. Also records your answer to a handoff: `declined` with a reason, `done`, `later`, or `reverted` |

Archiving, deleting, the source check, making rules, and weekly stats live in the app under **Your knowledge**, because they're your decisions, not agent work.

### Old tool names

Old names still answer, so published CLIs and hooks keep working. They're no longer listed:

| Old name | Now |
| --- | --- |
| `search_captures`, `list_inbox` | `search` |
| `recall`, `vault_scan`, `apply_to_context` | `briefing` |
| `get_rules` | `read_capture` with `RULES.md` |
| `generate_plan`, `list_plans` | replaced by handoffs |
| `archive_capture`, `delete_capture`, `curate`, `synthesize`, `apply_stats` | in the app under **Your knowledge** |

The names in the first four rows will be removed two CLI releases after the CLI stopped calling them.
