<div align="center">
  <br>
  <a href="https://xkg.xmu.sh">
    <img src="https://raw.githubusercontent.com/xmu-labs/xkg/main/public/brand/xkg-icon-dark.png" width="160" height="160" alt="xkg">
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

**Learn it once. Your AI applies it.**

You read useful things all the time: articles, docs, talks, notes. Your AI coding agent never sees them. xkg saves that knowledge and hands it to your agent where it fits in your code.

For developers and builders who use AI agents like Claude Code, Codex, Cursor, or Gemini CLI. **[Get started](#get-started)**

## How it works

1. **Capture.** Paste a link, a doc, a transcript, or a note into xkg. It saves the main idea and key takeaways, each backed by a quote from the source, to a private GitHub repo you own.
2. **Match.** xkg suggests the repo and files where it may change something.
3. **Apply.** At your next coding session, your agent offers it, reads the code, writes a plan, and asks you before changing anything.

<p align="center">
  <img src="https://raw.githubusercontent.com/xmu-labs/xkg/main/public/flow-workflow.svg" width="720" alt="Docs and notes → Capture → GitHub Markdown → Brief → Plan → Execute → Mark applied" />
</p>

More detail: [How xkg works](https://github.com/xmu-labs/xkg/blob/main/docs/how-it-works.md).

## Get started

**Choose:** start in the web app to try it in 2 minutes. Add the terminal step when you want your coding agent to use it.

### 1. Web app (no terminal)

1. Open **[xkg.xmu.sh](https://xkg.xmu.sh)** and sign in with GitHub. xkg creates a private repo for your knowledge, named `xkg-knowledge` unless you pick another name.
2. Pick your AI provider, paste your API key, and set a PIN (6+ characters) for quick unlock. Providers: Anthropic, OpenAI, Google Gemini, OpenRouter, xAI Grok, DeepSeek, Mistral, or Groq.
3. Paste something and hit **Capture**.

On a phone, use **Share → Add to Home Screen**.

### 2. Coding agents (one command)

Run this once on each computer:

```bash
npx -y @xmu-labs/xkg@latest init
```

It signs you in through the browser and sets up every coding agent it finds: Claude Code, Codex, Gemini CLI, GitHub Copilot, and Cursor. It backs up each file it changes and ends with a health check. Check again any time with `npx -y @xmu-labs/xkg@latest doctor`.

## Connect a chat app

For Claude, ChatGPT, or Grok, add a custom connector named `xkg` with this URL, then sign in with GitHub:

```text
https://xkg.xmu.sh/api/mcp
```

Step-by-step for each app, manual setup for any agent, and how to remove xkg: [Connect your AI](https://github.com/xmu-labs/xkg/blob/main/docs/connect.md).

## What your agent can do

You don't need to learn these. Ask in plain words: "save this", "what do I have on payments?", "brief me for this repo".

| Tool | What it does |
| --- | --- |
| `capture` | Saves knowledge from text or a URL |
| `briefing` | Shows captures that may fit your repo or current task |
| `search` | Finds captures by words, tag, status, or date |
| `read_capture` | Reads one capture in full |
| `apply_capture` | Records that a commit applied a capture, or your answer to an offer |

All commands: [CLI and tools](https://github.com/xmu-labs/xkg/blob/main/docs/cli.md).

## Your data stays yours

- **Your captures live in your GitHub repo** as plain Markdown, private by default. Delete xkg and keep everything.
- **xkg never sees your code.** For matching, it gets at most file names, function names, and signatures.
- **Your AI key, your cost.** Captures go only to the AI provider you chose. If you sync code maps, a summary also goes to TypeSafe for matching. Nothing is used for training.
- **Keys are encrypted or hashed.** xkg's database holds account plumbing only, with no captures.
- **Cut access any time.** A new key in Settings revokes every connection.

Every claim, with the code that backs it: [Privacy and data](https://github.com/xmu-labs/xkg/blob/main/docs/privacy-and-data.md).

## Cost

xkg doesn't charge for AI; you pay your provider directly. 100 captures a month cost about $0.80 on Claude Haiku 4.5, or about $0.10 on GPT-4o mini. Settings → AI model shows what xkg spent with your key this month. Details: [Cost](https://github.com/xmu-labs/xkg/blob/main/docs/how-it-works.md#cost).

## Roadmap

- **Learning graph:** what you applied feeds the next briefing.
- **Team graph:** one knowledge graph for a team and its AI agents.
- **Chrome extension:** capture from the page you're on.
- **Voice memo:** speak it, and xkg turns it into a capture.

## More

- Docs: [How xkg works](https://github.com/xmu-labs/xkg/blob/main/docs/how-it-works.md) · [Connect your AI](https://github.com/xmu-labs/xkg/blob/main/docs/connect.md) · [CLI and tools](https://github.com/xmu-labs/xkg/blob/main/docs/cli.md) · [Privacy and data](https://github.com/xmu-labs/xkg/blob/main/docs/privacy-and-data.md)
- What changed: [Releases](https://github.com/xmu-labs/xkg/releases)
- Contributing: [CONTRIBUTING.md](https://github.com/xmu-labs/xkg/blob/main/CONTRIBUTING.md) · [Code of Conduct](https://github.com/xmu-labs/xkg/blob/main/CODE_OF_CONDUCT.md) · [Security](https://github.com/xmu-labs/xkg/blob/main/SECURITY.md)

## License

[MIT](https://github.com/xmu-labs/xkg/blob/main/LICENSE). The license covers the code, not the xkg name or logo. Other product names are trademarks of their owners and only show which tools xkg works with.
