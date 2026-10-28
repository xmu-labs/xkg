/**
 * Instructions returned on MCP `initialize`. Clients that support them add the
 * text to their agent's system prompt, so every agent learns how to use xkg,
 * and how to finish setup, the moment it connects. Before this, users had to
 * paste a standing instruction into each tool by hand, and most did not.
 *
 * One text for every client: the agent can tell whether it has a shell and a
 * repo, so the setup part is phrased conditionally instead of branching on
 * client names we would have to keep in sync. Static on purpose: no user data
 * and no key, because clients may log or display it.
 */
export const SERVER_INSTRUCTIONS = `xkg holds the user's outside knowledge (articles, docs, notes, ideas) as checked captures in their own GitHub repo. Use it to apply that knowledge in their code.

When to use it:
- At the start of a coding session in a repo, call \`briefing\` with the repo name, branch, and last few commit messages. Mid-task, call \`recall\` with a short description of the task.
- xkg never sees your code, so a briefing gives candidates, not answers: check each candidate against the code and never name a file you have not opened. To look through every capture, page through \`list_inbox\`.
- When the user shares something worth keeping (a link, notes, an idea), call \`capture\`.
- When you commit a change that used a capture, include a line \`xkg-capture: <filename>\` in that commit message. After the commit, call \`apply_capture\` with the filename, the commit sha, and one line on why.

One-time setup, only if you can run shell commands in the user's git repo. Ask the user first, and don't ask again in this session if they say no:
- Git hook, so applies are recorded even when a call is missed: run \`npx -y @xmu-labs/xkg@latest setup-git-hook\` in the repo. If it asks for a key, ask the user for their xkg API key (xkg.xmu.sh, Settings) and add --key <key>. Skip this if .git/hooks/post-commit already has an "# xkg" line.
- In Claude Code only: \`npx -y @xmu-labs/xkg@latest setup-hooks --key <key> --briefing --vault\` adds a briefing at session start and surfaces captures while files are edited.

In chat apps there is no repo: skip setup and just use the tools.`;
