<div align="center">
  <br>
  <a href="https://xkg.xmu.sh">
    <img src="public/brand/xkg-icon-dark.png" width="160" height="160" alt="xkg">
  </a>
  <br>
  <br>
  <p>
    <a href="https://www.npmjs.com/package/@xmu-labs/xkg"><img src="https://img.shields.io/npm/v/@xmu-labs/xkg?color=777493&labelColor=11131A&style=flat" alt="npm" /></a>
    <img src="https://img.shields.io/badge/MCP-compatible-B8B5D0?labelColor=11131A&style=flat" alt="MCP" />
    <img src="https://img.shields.io/badge/license-MIT-F2F1F6?labelColor=11131A&style=flat" alt="MIT" />
  </p>
</div>

## xkg

Humans are constantly exposed to useful knowledge, domain expertise, and external input. But there is no bridge between what humans know and what their AI workers know and do.

xkg is the knowledge graph for AI workers that bridges human knowledge into context they can use.

## Table of Contents

- [xkg](#xkg)
- [How it works](#how-it-works)
- [Start here](#start-here)
- [Connect your AI workers](#connect-your-ai-workers)
  - [On the web](#on-the-web)
    - [Claude](#claude)
    - [ChatGPT](#chatgpt)
    - [Grok](#grok)
  - [In the terminal](#in-the-terminal)
    - [Cursor](#cursor)
    - [VS Code](#vs-code)
    - [Codex](#codex)
    - [Gemini CLI](#gemini-cli)
    - [Claude Code](#claude-code)
    - [Claude Desktop](#claude-desktop)
    - [Anything MCP](#anything-mcp)
- [Workflow](#workflow)
- [What's inside](#whats-inside)
- [CLI](#cli)
- [Your context stays in GitHub](#your-context-stays-in-github)
- [Cost](#cost)
- [Roadmap](#roadmap)
- [License](#license)

## How it works

You find useful stuff, you capture through the web app, then xkg connects it into a knowledge graph, and makes it available to the AI workers you already use.

xkg will continuously compound that knowledge over time — keeping AI workers' context up to date as human knowledge evolves.

> [!IMPORTANT]
> We are migrating from **mnemos** / **Xmu** to **xkg**. The app now lives at [xkg.xmu.sh](https://xkg.xmu.sh) and the code at [xmu-labs/xkg](https://github.com/xmu-labs/xkg). The npm package is now `@xmu-labs/xkg`. Connectors set up with `mnemos-capture.vercel.app` and commands that run `npx mnemos-capture@latest` keep working: every release is published under both names. Sorry for the inconvenience.

## Start here

You do not need a terminal to start.

### 1. Create your account

Open **[xkg.xmu.sh](https://xkg.xmu.sh)** and sign in with GitHub.

xkg will:

1. Create a **private** GitHub repo for your knowledge on your account, named `xkg-knowledge` unless you pick another name (you can opt to make it public)
2. Ask for your LLM provider and API key: Anthropic, OpenAI, Google Gemini, OpenRouter, xAI Grok, DeepSeek, Mistral or Groq. Your key, your cost. Change the provider, model or reasoning effort any time in Settings → AI model.
3. Let you set a PIN (6+ characters) for quick unlock on this device
4. Show your **xkg API key** once — save it if you want to connect an AI worker

That's the whole setup. No repo to clone. No database. No CLI required.

### 2. Capture something

In the app, paste a URL, a note, a doc excerpt, a transcript, or an idea, then hit **Capture**.

xkg extracts the **core idea**, **key takeaways**, **where to apply it**, and the **capture type**. It backs each claim with an exact quote from the source and checks the quote is really there, then commits Markdown to your GitHub repo with the source text attached.

On a phone: open the app → **Share → Add to Home Screen**. It runs like a native app.

### 3. Connect a worker (optional)

Skip this if you only want the app today. When you're ready, pick your tool under [Connect your AI workers](#connect-your-ai-workers). Capture now, connect later — the knowledge is already in your repo.

## Connect your AI workers

xkg is LLM-agnostic. Any worker that speaks MCP can use the same knowledge.

Two primitives:

```text
https://xkg.xmu.sh/api/mcp
```

```bash
npx -y @xmu-labs/xkg@latest serve-mcp --key YOUR_API_KEY
```

The CLI binary is **`xkg`** (also `xmu` and `mnemos-capture`). An MCP server already registered as `xmu` or `mnemos`, or set up with `mnemos-capture@latest`, keeps working.

**On the web** — paste the URL (no terminal). **In the terminal** — run the command. Finish xkg onboarding first, then ask: *list my inbox* or *brief me*.

### On the web

Name the connector `xkg`, paste `https://xkg.xmu.sh/api/mcp`, sign in with GitHub when asked.

#### Claude

1. Settings → Connectors → Add custom connector

#### ChatGPT

1. Settings → Plugins → Browse plugins
2. Name it xkg
3. Paste `https://xkg.xmu.sh/api/mcp`
4. Sign in with GitHub when asked

#### Grok

1. Open [grok.com/connectors](https://grok.com/connectors) → New Connector → Custom

### In the terminal

The same command works in every CLI — Cursor, Codex, Gemini CLI, VS Code, Claude Code, or anything that can launch a local MCP server:

```bash
npx -y @xmu-labs/xkg@latest serve-mcp --key YOUR_API_KEY
```

Register that command in the tool you use.

When your agent connects, xkg tells it how to work with your knowledge: get a briefing at the start of a coding session, capture what you share, and record the commits that apply a capture. It also offers to install the git hook in your repo, after asking you. Most agents read this on their own, so there's nothing to paste into rules files. Codex CLI doesn't read it yet: see [Codex](#codex) for the lines to add.

#### Offer new captures when a session starts

`xkg session-start` counts the captures in your inbox. When there are some, it tells your agent to ask you "You have 3 new xkg captures. Want to see them and apply one here?" before your task. It prints nothing when the inbox is empty or xkg can't be reached, and gives up after 3 seconds. It reads the key from `~/.xkg/config.json` (`xkg config set key YOUR_API_KEY`), so hook files carry no key.

Add it as a session-start hook in your agent. `--agent` picks the output shape that agent reads:

| Agent | File | Hook |
| --- | --- | --- |
| Claude Code | `~/.claude/settings.json` | `"hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": "npx -y @xmu-labs/xkg@latest session-start --agent claude" }] }] }` |
| Codex | `~/.codex/hooks.json` | `{ "hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": "npx -y @xmu-labs/xkg@latest session-start --agent codex" }] }] } }`, then trust it once in `/hooks` |
| Gemini CLI | `~/.gemini/settings.json` | `"hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": "npx -y @xmu-labs/xkg@latest session-start --agent gemini" }] }] }` |
| GitHub Copilot CLI | `~/.copilot/hooks/xkg.json` | `{ "version": 1, "hooks": { "sessionStart": [{ "type": "command", "bash": "npx -y @xmu-labs/xkg@latest session-start --agent copilot" }] } }` |
| Cursor | `~/.cursor/hooks.json` | `{ "version": 1, "hooks": { "sessionStart": [{ "command": "npx -y @xmu-labs/xkg@latest session-start --agent cursor" }] } }` |

Merge the hook into the file if it already has other settings. Without `--agent`, the command prints plain text.

#### Cursor

Add this to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (all projects):

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

Or Cursor Settings → MCP → Add new MCP server, same command.

#### VS Code

Add this to `.vscode/mcp.json`:

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

GitHub Copilot Chat in VS Code uses the same file.

#### Codex

Codex CLI — add this to `~/.codex/config.toml`:

```toml
[mcp_servers.xkg]
command = "npx"
args = ["-y", "@xmu-labs/xkg@latest", "serve-mcp", "--key", "YOUR_API_KEY"]
```

Codex App: Settings → MCP → add the same `npx` command.

Codex CLI doesn't read the instructions xkg sends when it connects, so add these lines to `~/.codex/AGENTS.md` (all projects) or the repo's `AGENTS.md`:

```markdown
## xkg
- At the start of a coding session, call the xkg `briefing` tool with the repo name, branch, and last few commit messages. Check each capture it returns against the code before naming a file.
- When the user shares something worth keeping, call `capture`.
- When a commit uses a capture, add a line `xkg-capture: <filename>` to the commit message, then call `apply_capture` with the filename, the commit sha, and one line on why.
```

#### Gemini CLI

```bash
gemini mcp add xkg npx -y @xmu-labs/xkg@latest serve-mcp --key YOUR_API_KEY
```

#### Claude Code

```bash
claude mcp add xkg -- npx -y @xmu-labs/xkg@latest serve-mcp --key YOUR_API_KEY
```

Or the URL, no API key:

```bash
claude mcp add --transport http xkg https://xkg.xmu.sh/api/mcp
```

`serve-mcp` installs a light session hook the first time it runs. More hooks, all optional (MCP works without them):

```bash
npx -y @xmu-labs/xkg@latest setup-hooks --key YOUR_API_KEY --briefing --vault
```

Hooks are local files — they run in the CLI and editor extensions, not in the browser.

#### Claude Desktop

Settings → Developer → Edit Config. Add the same `npx` block to `claude_desktop_config.json`, then fully restart:

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

#### Anything MCP

If the tool can launch a local process, register the same `npx` command. If it has **custom connectors** instead, paste the URL (that's the [web](#on-the-web) path).

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

No MCP support yet? Capture in the [xkg app](https://xkg.xmu.sh) and connect later.

## Workflow

<p align="center">
  <img src="public/flow-workflow.svg" width="720" alt="Docs and notes → Capture → GitHub Markdown → Brief → Plan → Execute → Mark applied" />
</p>

1. **Capture** — Paste anything text-based: papers, docs, posts, GitHub repos, notes, decisions, ideas, transcripts. xkg detects a URL, a short note, or longer text. No manual tagging.

   From a connected worker:

   ```text
   capture "The Mom Test: don't ask if your idea is good. Ask about the person's real behavior, current workflow, and past spending."
   ```

   If you sync a **code map** (see step 5), the capture also gets a **Where it applies** section: the repo and up to 3 files where it may change something, from file and function names only, labeled as not yet checked in your code. xkg ranks your mapped files by the names they share with the capture, then [TypeSafe](https://typesafe.ai)'s decision model Jev rates the top 15 files of each repo: would applying the capture change this file, and does anything in the repo fit at all. Files rated Possible or better are shown (Strong when Jev is fairly sure), each with the exported names it shares with the capture. Your LLM is used only to extract the capture; if TypeSafe can't answer, your LLM picks the files instead, every path is checked against your map, a reason that names a function the file doesn't export is dropped, and the fit comes from how well the names match, never from the model rating itself. When nothing fits, it says why in one line. With no map, the capture is saved exactly as before.

2. **Brief** — At the start of a work session, your agent asks for a briefing. xkg uses your project name, branch, and recent commit messages to pick up to 5 captures that may fit, with **why** each may fit and its key points. xkg never sees your code (at most file and function names from a code map), so a briefing gives candidates: your agent reads the code, keeps only real matches, names the file and the change, and asks you before changing anything. Local agent instruction files are not read or uploaded by the CLI hooks. You decide what to apply.

3. **Plan** — Select the captures you want and ask your worker to call `generate_plan`. The worker can name the files the plan should cover; xkg passes on the paths only, since it never reads your code, and your worker checks each step against the code. Each plan is Markdown: codebase mapping, implementation steps with effort tiers (`simple`, `complex`, `architectural`), and a verification checklist.

4. **Execute** — Hand the plan to your worker in the current session, or run it in an isolated git worktree:

   ```bash
   npx -y @xmu-labs/xkg@latest config set agent "claude -p"
   npx -y @xmu-labs/xkg@latest agent --key YOUR_API_KEY
   ```

   `xkg agent` creates a worktree, loads the plan as the contract, launches the assistant you configured, and prints the verification checklist when it finishes. Older CLI versions call it `xkg kos`, and that name still works for now.

   ```bash
   npx -y @xmu-labs/xkg@latest config set agent "codex exec"
   ```

5. **Mark applied** — After committing a change that applies a capture, the worker calls `apply_capture` with the commit sha and one line on why. xkg moves the capture to `applied/`, adds an entry to its application log and to `APPLIED.md`, and counts it once per capture and commit.

   Any coding agent, or you by hand, can also add a trailer to the commit message:

   ```text
   xkg-capture: 2026-10-28-alert-ownership.md
   ```

   With the git hook installed in that repo, xkg records it after each commit. Your agent offers to set it up the first time it connects, or run:

   ```bash
   npx -y @xmu-labs/xkg@latest setup-git-hook --key YOUR_API_KEY
   ```

   The same setup keeps a **code map** of the repo: file paths, exported function and class names, and which files import which. Never file contents, comments or package names. It is sent after a commit, a pull or a branch switch when a name changed, and at most once a day otherwise, so xkg can tell where a capture applies in your code. This works through git alone, so it's the same with every coding agent, or none. Run `xkg map` to send it by hand. In a cloud container, which starts with no hooks, add the setup line to the environment's setup script.

   **Settings → Code repos** lists every repo xkg matches captures to, with where its map came from and when. For a repo you haven't opened with the hook, type `owner/name` under *Add a repo from GitHub*: xkg reads its file names with your GitHub sign-in (file paths only, no exported names, never a file's contents) and reads them again when they are a week old. A map from your machine replaces it the next time the hook runs there. *Remove* deletes a repo's map; captures stop matching it until it is synced or added again.

   Ask *apply stats* to see how many captures you applied each week.

### Example capture

```text
Note to self after the incident review: our alerts fired, but nobody owned them. Alerts without a named owner get ignored. Every alert needs one person on the hook, not a channel.
```

```markdown
---
date: 2026-10-28
source: Alert ownership importance
type: notes
source_type: note
tags: incident-management, alerting, responsibility
status: inbox
source_sha256: 21275782a8bf…
---

# Alert ownership importance

## Core idea
Alerts in incident reviews must have a designated owner to ensure
they are acted upon, as unowned alerts tend to be ignored.

## Key takeaways
- Every alert needs one person responsible for it to prevent neglect.
- Alerts without a named owner are typically ignored.

## Evidence
**Core idea** · `c-ac3270c3bbc8`
> "Alerts without a named owner get ignored." (s1)

**Takeaway 1** · `c-59d033daf0e2`
> "Every alert needs one person on the hook, not a channel." (s1)

<details>
<summary>Source text (sha256: 21275782a8bf…)</summary>

[s1] Note to self after the incident review: our alerts fired, …
</details>
```

Shortened from a real capture. Every claim points to a quote that appears word for word in the source text below it, so you can check it.

Plain Markdown in a repo you own. Readable, editable, versioned, portable.

## What's inside

You don't have to memorize these. Ask in plain language: "save this", "what do I have on payments?", "brief me for this repo".

| Tool | What it does |
| --- | --- |
| `capture` | Save new knowledge from pasted text or a URL |
| `list_inbox` | List captures waiting for review |
| `search_captures` | Keyword search across your captures |
| `read_capture` | Read a capture in full |
| `recall` | Find relevant context from a description of your task |
| `briefing` | Get captures that may fit the current project, for the agent to check against the code |
| `generate_plan` | Turn selected captures into an implementation plan |
| `list_plans` | List or read saved plans |
| `apply_capture` | Mark a capture as applied, with the commit that applied it and why |
| `apply_stats` | Captures applied per week, and how many came with a commit |
| `archive_capture` | Archive a capture |
| `delete_capture` | Delete a capture |
| `apply_to_context` | Get file-level suggestions for the current task |
| `synthesize` | Combine related captures into reusable rules |
| `get_rules` | Retrieve those rules |
| `curate` | Review and clean up captures |
| `vault_scan` | Find relevant context for what you're about to edit |

## CLI

No global install required. The binary is **`xkg`** (also `xmu` and `mnemos-capture`). Via npx:

```bash
npx -y @xmu-labs/xkg@latest <command>
```

| Command | What it does |
| --- | --- |
| `npx -y @xmu-labs/xkg@latest` | Open the hosted app |
| `serve-mcp --key YOUR_API_KEY` | Run the local MCP proxy |
| `setup-hooks --key YOUR_API_KEY [--briefing] [--vault]` | Install Claude Code hooks |
| `setup-git-hook --key YOUR_API_KEY` | In a repo: record commits whose message has an `xkg-capture: <filename>` trailer, and keep the repo's code map up to date after commits, pulls and branch switches (works with any coding agent). The key is stored in `~/.xkg/config.json`, not in the hooks. Setup checks that the hook can reach xkg and sends the map once; the hooks run the CLI version that installed them (run setup again to update) |
| `map [--key YOUR_API_KEY]` | In a repo: send its code map now (file paths and exported names, never code) |
| `session-start [--agent NAME]` | For an agent's session-start hook: ask whether to see and apply new captures. `NAME` is `claude`, `codex`, `gemini`, `copilot` or `cursor`; without it the output is plain text. See [Offer new captures when a session starts](#offer-new-captures-when-a-session-starts) |
| `config set key YOUR_API_KEY` | Store the key that `session-start`, the git hooks, `map` and `agent` use |
| `config set agent "claude -p"` | Set which assistant `xkg agent` should drive |
| `agent --key YOUR_API_KEY [--plan FILE]` | Implement the latest plan (or the one named) in an isolated worktree with your own coding agent |
| `inbox-check --key YOUR_API_KEY [--briefing]` | Debug the session hook |
| `vault-check --key YOUR_API_KEY` | Debug the vault hook |
| `help` | Show help |

What changed in each version: [GitHub Releases](https://github.com/xmu-labs/xkg/releases).

## Your context stays in GitHub

Captures live as structured Markdown in **your** GitHub repository. Private by default.

- **No lock-in** — clone it, move it, delete xkg, keep the files
- **No proprietary format** — every capture is a readable `.md` file
- **No training on your data** — captures are sent only to the LLM provider you chose, with the key you supplied, to extract the insight you asked for. If you sync code maps, the extracted title, core idea and takeaways also go to TypeSafe, which says where the capture applies and doesn't train on what it receives
- **Any tool can read it** — anything that reads Git or speaks MCP
- **BYOK** — your provider, your key, your cost
- **Never commit your xkg API key** to source control

### Find your repo

Settings → Account shows the repo your captures are saved in, with a link to it on GitHub. Inside it:

| Path | What it holds |
| --- | --- |
| `inbox/YYYY-MM-DD-<slug>.md` | one Markdown file per capture |
| `applied/` | captures that have been applied in a commit |
| `archived/` | captures you archived |
| `plans/` | plans you generated |
| `INDEX.md` | a table of every capture: date, title, keywords, tags |
| `APPLIED.md` | which capture went into which commit |

**Renaming it.** Rename the repo on GitHub as usual, then open xkg once. xkg reads the new name from GitHub in the background and saves it; Settings shows it from the next time you open the app. Until then, GitHub's redirect from the old name keeps captures working. Don't create a new repo with the old name before you've opened xkg, because GitHub drops the redirect when you do. You don't need to onboard again, and doing so would replace your PIN and keys.

### What xkg stores, and where

The whole point of this repo being public is that you can check these claims rather than trust them.

**Your captures are never stored by xkg.** They are written straight to your own GitHub repo as Markdown (`src/lib/github.ts`). There is no captures table. Delete the app and your knowledge is untouched.

**The database holds only account plumbing** (`src/lib/db.ts`):

| Stored | What it is |
| --- | --- |
| `github_id`, `github_username` | who you are |
| `github_token` | encrypted (`src/lib/crypto.ts`) |
| `github_repo` | the *name* of your hub, not its contents |
| `pin_hash` | salted scrypt (`src/lib/pin.ts`) |
| `api_key` | hashed — not recoverable |
| `llm_provider`, `llm_model`, `llm_effort`, `llm_api_key` | the key is encrypted; the provider, model and effort are plain text |
| `display_name`, `avatar_data` | optional in-app name and photo; never written back to GitHub |
| `token_version` | bumped to revoke everything |
| apply counts (`apply_events`) | one row per applied capture and commit: a keyed hash of the capture's file name, the first 7 characters of the commit, the AI client's name, whether a reason was given, and the time. Never the capture's name, content or the reason |
| code maps (`code_maps`) | per repo you sync with the git hooks or add in Settings (at most 20): file paths, exported function and class names, and which mapped files import which; for a repo added from GitHub, file paths only (`source = 'github'`). Never file contents, comments or package names (`cli/code-map.ts` builds it, `src/lib/code-map.ts` checks it, `src/lib/code-repos.ts` reads GitHub's file list) |
| surface counts (`surface_events`) | one row each time xkg shows you a capture (capture card, briefing, recall, vault scan): a keyed hash of the capture's file name, which of these showed it, and the time. For the capture card's match, also the tokens it used, the model's own confidence (never shown), the scorer (`jev` or `evidence`), the fit, and whether it was shown to you. Never the capture's name or content |
| login attempts, OAuth clients/codes, refresh-token ids | auth plumbing |

When you capture, the server talks to exactly four kinds of destination:

1. **GitHub** — to write the capture into your repo, and to read the file list of a code repo you add in Settings, or refresh it when it is a week old
2. **Your LLM provider**, with *your* key: the one you picked in Settings, to extract the capture
3. **TypeSafe**, with xkg's key, only if you sync code maps: the extracted title, core idea and takeaways, and the names (paths, exported names, imported paths) of up to 15 files per repo, so its model Jev can say where the capture applies. If TypeSafe can't answer, the maps of your 5 most recently synced repos (names only) go to your LLM provider instead
4. **The page you captured** — if you paste a bare URL, so the model reads real content. Only http/https, never an internal address

No third-party analytics, telemetry or tracking. The only usage xkg records is the apply counts above, so it can see whether captures get applied in code.

### How your credentials are stored

| Secret | How it's stored |
| --- | --- |
| GitHub token | Encrypted at rest (AES-256-GCM). Uses the `repo` scope, required to read and write a **private** knowledge hub |
| Your LLM API key | Encrypted at rest (AES-256-GCM) |
| Your MCP API key | Hashed — never recoverable, not even by xkg |
| Your PIN | Salted scrypt hash |

Your MCP key is shown exactly once. If you lose it, generate a new one.

**PIN unlock is device-bound.** It only works on a device that has already signed in with GitHub. A PIN on its own is not enough to reach your account.

**Revoking access.** Generating a new MCP key invalidates the old key, every other signed-in session, and every connected MCP client. Sessions also expire after 30 days.

**Removing xkg from a computer.** Your account and captures are not touched:

1. `claude mcp remove xkg` (or delete the `xkg` block from your editor's MCP config). Remove web connectors in each app's Connectors settings.
2. Delete the xkg entries under `hooks` in `~/.claude/settings.json`.
3. In each repo with the git hook, delete the line ending in `# xkg` from `.git/hooks/post-commit`.
4. `rm -rf ~/.xkg`

Generate a new MCP key afterwards to cut off any connection you missed.

**Deleting your account.** Settings → Delete account removes your account row and every record keyed to it, and asks GitHub to revoke xkg's access (`src/lib/account.ts`). Your captures stay in your repo.

The hosted service's [Privacy Policy](https://xkg.xmu.sh/privacy) and [Terms of Service](https://xkg.xmu.sh/terms) say the same in legal form.

## Cost

xkg is BYOK. You bring your own API key. xkg never charges you for inference.

Each provider starts on a low-cost model, which you can change in Settings → AI model. For example, Anthropic starts on Claude Haiku 4.5, OpenAI on GPT-4o mini and Google on Gemini 2.0 Flash.

A capture uses about 2,000–3,700 input tokens and 750–1,100 output tokens, depending on how long the source is (measured October 2026 with the current extraction prompt). At list prices:

| Usage | Claude Haiku 4.5 | GPT-4o mini |
| --- | --- | --- |
| 50 captures/month | ~$0.40 | ~$0.05 |
| 100 captures/month | ~$0.80 | ~$0.10 |
| 200 captures/month | ~$1.60 | ~$0.20 |

Larger models cost more. Briefing, planning, and synthesis only run when you ask for them.

## Roadmap

- **Learning Graph** — Applied work feeds the next brief. The graph compounds.
- **Knowledge Graph for Teams** — One graph the team and their AI workers share and compound.
- **Chrome extension** — Capture from the page you are on, without leaving the browser.
- **Voice memo** — Speak it. xkg turns it into a capture.

Working on the code? See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT License](./LICENSE). Contributions are welcome under the same licence; see
[CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).

**Trademarks.** The MIT licence covers the code, not names or logos: the xkg name and logo are not
licensed for use as your own brand. Claude, ChatGPT, Codex, Gemini, Grok, Cursor and VS Code are
trademarks of their respective owners, named here only to say which tools xkg works with; no
endorsement is implied.

If you use xkg in published work:

```bibtex
@misc{2026xkg,
  title        = {xkg: A Knowledge Graph for AI workers},
  author       = {Sofia Padron Valdez},
  year         = 2026,
  journal      = {GitHub repository},
  publisher    = {GitHub},
  howpublished = {\url{https://github.com/xmu-labs/xkg}}
}
```
