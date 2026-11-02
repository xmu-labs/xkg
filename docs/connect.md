# Connect your AI to xkg

**What's here:** how to connect a chat app or a coding agent to xkg, by hand or with one command, and how to remove it.
**Before you start:** sign in at [xkg.xmu.sh](https://xkg.xmu.sh) and finish setup in the app.

## Pick your path

| You use | Do this |
| --- | --- |
| A chat app (Claude, ChatGPT, Grok) | [Add a web connector](#chat-apps). No terminal. |
| Coding agents on your computer | [Run `init` once](#coding-agents-one-command). It sets up every agent it finds. |
| Something `init` doesn't cover | [Set it up by hand](#set-up-an-agent-by-hand). |

Any tool that speaks MCP works. xkg gives it two ways in:

```text
https://xkg.xmu.sh/api/mcp
```

```bash
npx -y @xmu-labs/xkg@latest serve-mcp --key YOUR_API_KEY
```

## Chat apps

Name the connector `xkg`, paste `https://xkg.xmu.sh/api/mcp`, and sign in with GitHub when asked.

- **Claude:** Settings → Connectors → Add custom connector.
- **ChatGPT:**
  1. Settings → Security and login → turn on **Developer mode**. On Business, Enterprise, and Edu plans, an admin may have to allow it.
  2. Settings → Plugins → Browse plugins → **+** (top right).
  3. Name it xkg, choose **Server URL**, paste the URL, and pick **OAuth**.
  4. Tick the risk box, click **Create**, and sign in with GitHub.
- **Grok:** open [grok.com/connectors](https://grok.com/connectors) → New Connector → Custom.

When a chat starts, your AI tells you how many captures wait in your inbox and shows the newest few. You can also ask "what's in my inbox?" or "what do I have on payments?"

## Coding agents: one command

Run this once on each computer:

```bash
npx -y @xmu-labs/xkg@latest init
```

1. **Sign in.** It opens a page on xkg.xmu.sh with this computer's name and a code. Check that the code matches your terminal, then approve.
2. **Confirm.** It finds Claude Code, Codex, Gemini CLI, GitHub Copilot, and Cursor, lists what it will change, and asks once.
3. **Check.** It runs `xkg doctor` to confirm everything works.

Each computer gets its own key, so a new sign-in never cuts off another computer. On a machine with no browser (a server, CI), use a key from Settings: `init --key YOUR_API_KEY`.

Options: `--yes` skips the question. `--agents codex,cursor` limits it to those agents.

### What `init` changes

For each agent, it adds an MCP server, a session-start hook, and a rules block. None of them holds your key; the key lives in `~/.xkg/config.json`.

| Agent | MCP server | Session-start hook | Rules block |
| --- | --- | --- | --- |
| Claude Code | `claude mcp add-json -s user xkg` | `~/.claude/settings.json` | `~/.claude/CLAUDE.md` |
| Codex | `~/.codex/config.toml` | `~/.codex/hooks.json` (trust it once in `/hooks`) | `~/.codex/AGENTS.md` |
| Gemini CLI | `~/.gemini/settings.json` | `~/.gemini/settings.json` | `~/.gemini/GEMINI.md` |
| GitHub Copilot | `~/.copilot/mcp-config.json` | `~/.copilot/hooks/xkg.json` | `~/.copilot/copilot-instructions.md` |
| Cursor | `~/.cursor/mcp.json` | `~/.cursor/hooks.json` | none (Cursor keeps User Rules in the app) |

- The rules block is the same text in every file, between `<!-- xkg -->` and `<!-- /xkg -->`.
- Inside a git repo, `init` also installs the [git hook](how-it-works.md#5-mark-it-applied) and sends the code map.
- It keeps your other settings and leaves anything xkg already set up alone, including a hand-written `## xkg` section.
- In Claude Code, it replaces the older `inbox-check` hook so a session doesn't get two offers.
- It backs up each file to `~/.xkg/backups/` first and prints how to undo each change.

### Check your setup

```bash
npx -y @xmu-labs/xkg@latest doctor
```

It checks your key, the server, your knowledge repo, each agent, and this repo's git hooks and code map. Then it shows what your agent would see at session start. Each problem comes with the command that fixes it.

It changes nothing. `--json` prints the result for scripts, and it exits with 1 when a check fails.

## What your agent is told

When your agent connects, xkg tells it how to use your knowledge:

- Get a briefing at the start of a coding session, and again when the session moves to another repo, so each repo's waiting captures show up there.
- Capture what you share.
- Record the commits that apply a capture.
- Offer to install the git hook in your repo, after asking you.

Most agents read this on their own. Codex CLI doesn't yet, so `init` writes the same lines into `~/.codex/AGENTS.md`. If you set up Codex by hand, [add them yourself](#codex).

## Offer new captures when a session starts

The session-start hook runs `xkg session-start`. When a session starts, your agent offers what's waiting:

- **Captures matched to this repo** (from `HANDOFFS.md`): "xkg: 2 captures fit this repo (owner/name). Want to see them and apply one?" It lists up to 3. See [handoffs](how-it-works.md#1-capture).
- **Otherwise, new captures in your inbox:** "You have 3 new xkg captures. Want to see them and apply one here?"

It stays quiet when nothing waits or xkg can't be reached, and gives up after 3 seconds. It speaks once per session: when the agent compacts or forks the chat, it prints nothing. It reads the key from `~/.xkg/config.json` (`xkg config set key YOUR_API_KEY`), so hook files hold no key.

`init` adds the hook for you. To add it by hand, merge this into the agent's file. `--agent` picks the output format that agent reads; without it, the output is plain text.

| Agent | File | Hook |
| --- | --- | --- |
| Claude Code | `~/.claude/settings.json` | `"hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": "npx -y @xmu-labs/xkg@latest session-start --agent claude" }] }] }` |
| Codex | `~/.codex/hooks.json` | `{ "hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": "npx -y @xmu-labs/xkg@latest session-start --agent codex" }] }] } }`, then trust it once in `/hooks` |
| Gemini CLI | `~/.gemini/settings.json` | `"hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": "npx -y @xmu-labs/xkg@latest session-start --agent gemini" }] }] }` |
| GitHub Copilot CLI | `~/.copilot/hooks/xkg.json` | `{ "version": 1, "hooks": { "sessionStart": [{ "type": "command", "bash": "npx -y @xmu-labs/xkg@latest session-start --agent copilot" }] } }` |
| Cursor | `~/.cursor/hooks.json` | `{ "version": 1, "hooks": { "sessionStart": [{ "command": "npx -y @xmu-labs/xkg@latest session-start --agent cursor" }] } }` |

## Set up an agent by hand

Every agent runs the same command. Register it in your tool, with the key from Settings:

```bash
npx -y @xmu-labs/xkg@latest serve-mcp --key YOUR_API_KEY
```

### Cursor

Add this to `.cursor/mcp.json` (one project) or `~/.cursor/mcp.json` (all projects). Or use Cursor Settings → MCP → Add new MCP server with the same command.

```json
{
  "mcpServers": {
    "xkg": {
      "command": "npx",
      "args": ["-y", "@xmu-labs/xkg@latest", "serve-mcp", "--key", "YOUR_API_KEY"]
    }
  }
}
```

### VS Code

Add this to `.vscode/mcp.json`. GitHub Copilot Chat in VS Code uses the same file.

```json
{
  "servers": {
    "xkg": {
      "command": "npx",
      "args": ["-y", "@xmu-labs/xkg@latest", "serve-mcp", "--key", "YOUR_API_KEY"]
    }
  }
}
```

### Codex

Codex CLI: add this to `~/.codex/config.toml`. Codex App: Settings → MCP → add the same `npx` command.

```toml
[mcp_servers.xkg]
command = "npx"
args = ["-y", "@xmu-labs/xkg@latest", "serve-mcp", "--key", "YOUR_API_KEY"]
```

Codex CLI doesn't read the instructions xkg sends when it connects. Add these lines to `~/.codex/AGENTS.md` (all projects) or the repo's `AGENTS.md`:

```markdown
## xkg
- At the start of a coding session, call the xkg `briefing` tool with repo set to the origin's owner/name, and the repo name, branch, and last few commit messages. When the session moves to a different repo (the user opens or adds one), call `briefing` again with that repo's owner/name. Check each capture it returns against the code before naming a file.
- When the user shares something worth keeping, call `capture`.
- When a commit uses a capture, add a line `xkg-capture: <filename>` to the commit message, then call `apply_capture` with the filename, the commit sha, the repo, and one line on why. If the user turns a capture down, call it with outcome `declined`, or `later` for not now.
```

### Gemini CLI

```bash
gemini mcp add xkg npx -y @xmu-labs/xkg@latest serve-mcp --key YOUR_API_KEY
```

### Claude Code

```bash
claude mcp add xkg -- npx -y @xmu-labs/xkg@latest serve-mcp --key YOUR_API_KEY
```

Or use the URL, with no API key:

```bash
claude mcp add --transport http xkg https://xkg.xmu.sh/api/mcp
```

The first time `serve-mcp --key` runs, it installs a light session hook, unless a `session-start` hook is already there. A server set up by `init` has no key in its entry and installs nothing.

More hooks are optional; MCP works without them. Hooks are local files, so they run in the CLI and editor extensions, not in the browser.

```bash
npx -y @xmu-labs/xkg@latest setup-hooks --key YOUR_API_KEY --briefing --vault
```

### Claude Desktop

Settings → Developer → Edit Config. Add this to `claude_desktop_config.json`, then fully restart the app.

```json
{
  "mcpServers": {
    "xkg": {
      "command": "npx",
      "args": ["-y", "@xmu-labs/xkg@latest", "serve-mcp", "--key", "YOUR_API_KEY"]
    }
  }
}
```

### Any other MCP tool

- **It can launch a local process:** register the same `npx` command, using the JSON block above.
- **It has custom connectors instead:** paste the URL, as in [Chat apps](#chat-apps).
- **No MCP support yet:** capture in the [xkg app](https://xkg.xmu.sh) and connect later. Your knowledge is already in your repo.

## Old names still work

The CLI binary is `xkg`, also available as `xmu` and `mnemos-capture`. An MCP server registered as `xmu` or `mnemos` keeps working.

A server set up with `mnemos-capture@latest` is stuck on 1.8.0, the last version under that name. Switch its command to `@xmu-labs/xkg@latest`.

## Remove xkg from a computer

This doesn't touch your account or your captures.

1. **MCP server:** run `claude mcp remove xkg` for Claude Code. For other agents, delete the `xkg` entry from the agent's MCP file ([table above](#what-init-changes)) or your editor's MCP config. Remove web connectors in each app's Connectors settings.
2. **Hooks:** delete the xkg session-start hook from each agent's hook file. Also delete any older xkg hooks (`inbox-check`, `vault-check`) under `hooks` in `~/.claude/settings.json`.
3. **Rules:** delete the lines from `<!-- xkg -->` to `<!-- /xkg -->` in `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, and `~/.copilot/copilot-instructions.md`.
4. **Git hooks:** in each repo, delete the lines ending in `# xkg` from `.git/hooks/post-commit`, `post-merge`, and `post-checkout`.
5. **Local files:** `rm -rf ~/.xkg` (your key and the backups `init` made).

Then generate a new MCP key in Settings to cut off any connection you missed.
