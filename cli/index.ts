#!/usr/bin/env node

const HOSTED_URL = "https://xkg.xmu.sh";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "serve-mcp") {
    const { serveMcp } = await import("./mcp-server.js");
    await serveMcp();
    return;
  }

  if (command === "setup-hooks") {
    const { setupHooks } = await import("./hooks.js");
    const keyIdx = args.indexOf("--key");
    const apiKey = keyIdx !== -1 ? args[keyIdx + 1] : undefined;
    if (!apiKey) {
      console.error("Usage: npx @xmu-labs/xkg setup-hooks --key YOUR_API_KEY [--briefing] [--vault]");
      process.exit(1);
    }
    setupHooks(apiKey, { briefing: args.includes("--briefing"), vault: args.includes("--vault") });
    return;
  }

  if (command === "inbox-check") {
    const { inboxCheck } = await import("./hooks.js");
    const keyIdx = args.indexOf("--key");
    const apiKey = keyIdx !== -1 ? args[keyIdx + 1] : undefined;
    if (!apiKey) process.exit(0); // silent fail in hook context
    await inboxCheck(apiKey, { briefing: args.includes("--briefing") });
    return;
  }

  if (command === "vault-check") {
    const { vaultCheck } = await import("./hooks.js");
    const keyIdx = args.indexOf("--key");
    const apiKey = keyIdx !== -1 ? args[keyIdx + 1] : undefined;
    if (!apiKey) process.exit(0); // silent fail in hook context
    await vaultCheck(apiKey);
    return;
  }

  if (command === "setup-git-hook") {
    const { installGitHooks, checkHookConnection } = await import("./git-hook.js");
    const { syncCodeMap } = await import("./code-map.js");
    const { readConfig, setConfigField } = await import("./config.js");
    const keyIdx = args.indexOf("--key");
    const keyArg = keyIdx !== -1 ? args[keyIdx + 1] : undefined;
    // The hook file may be tracked in git, so the key lives in ~/.xkg/config.json instead
    if (keyArg) setConfigField("key", keyArg);
    if (!readConfig().key) {
      console.error("Usage: npx @xmu-labs/xkg setup-git-hook --key YOUR_API_KEY (run inside the repo)");
      process.exit(1);
    }
    try {
      const paths = installGitHooks();
      console.log(`xkg git hooks installed: ${paths.join(", ")}`);
      console.log("Commits with an `xkg-capture: <filename>` trailer are now recorded as applied.");
      console.log("Commits, pulls and branch switches keep this repo's code map (file and function names, never code) up to date.");
    } catch (err) {
      console.error(err instanceof Error && err.message.includes("not a shell script")
        ? err.message
        : "Not a git repository. Run this inside the repo you code in.");
      process.exit(1);
    }
    // The hook runs in the background with its output discarded, so check now that it can report.
    const check = await checkHookConnection(readConfig().key!);
    if (check.ok) {
      console.log("Checked: the hook reached xkg with your key.");
    } else {
      console.error(`The hook is installed but can't report yet: ${check.reason}`);
      process.exit(1);
    }
    console.log(syncMessage(await syncCodeMap(readConfig().key!, process.cwd(), { force: true })));
    return;
  }

  if (command === "map") {
    const { syncCodeMap } = await import("./code-map.js");
    const { readConfig } = await import("./config.js");
    const keyIdx = args.indexOf("--key");
    const apiKey = keyIdx !== -1 ? args[keyIdx + 1] : readConfig().key;
    if (!apiKey) {
      console.error("No API key. Pass --key YOUR_KEY or store it: xkg config set key YOUR_KEY");
      process.exit(1);
    }
    const result = await syncCodeMap(apiKey, process.cwd(), { force: true });
    if (result.status === "synced") {
      console.log(syncMessage(result));
    } else {
      console.error(syncMessage(result));
      process.exit(1);
    }
    return;
  }

  if (command === "sync-map") {
    const { syncCodeMap } = await import("./code-map.js");
    const { readConfig } = await import("./config.js");
    const apiKey = readConfig().key;
    if (!apiKey) process.exit(0); // silent fail in hook context
    await syncCodeMap(apiKey);
    return;
  }

  if (command === "post-commit") {
    const { postCommit } = await import("./git-hook.js");
    const { readConfig } = await import("./config.js");
    const keyIdx = args.indexOf("--key");
    const apiKey = keyIdx !== -1 ? args[keyIdx + 1] : readConfig().key;
    const shaIdx = args.indexOf("--sha");
    const sha = shaIdx !== -1 ? args[shaIdx + 1] : "HEAD";
    if (!apiKey || !sha) process.exit(0); // silent fail in hook context
    await postCommit(apiKey, sha);
    return;
  }

  if (command === "config") {
    const { runConfigCommand } = await import("./config.js");
    runConfigCommand(args.slice(1));
    return;
  }

  if (command === "kos") {
    const { kos } = await import("./kos.js");
    const { readConfig } = await import("./config.js");
    const keyIdx = args.indexOf("--key");
    const apiKey = keyIdx !== -1 ? args[keyIdx + 1] : readConfig().key;
    if (!apiKey) {
      console.error("No API key. Pass --key YOUR_KEY or store it: xkg config set key YOUR_KEY");
      process.exit(1);
    }
    const planIdx = args.indexOf("--plan");
    const plan = planIdx !== -1 ? args[planIdx + 1] : undefined;
    await kos(apiKey, { plan });
    return;
  }

  // Default: open the hosted app
  console.log("");
  console.log("  xkg — A knowledge graph for your AI workers\n");
  console.log(`  Open ${HOSTED_URL} to start capturing.`);
  console.log("");
  console.log("  First time? Sign in with GitHub — setup takes 30 seconds.");
  console.log("");
  console.log("  Connect an AI worker:");
  console.log("  claude mcp add xkg -- npx -y @xmu-labs/xkg@latest serve-mcp --key YOUR_API_KEY");
  console.log("");

  // Try to open the URL in the default browser
  const { exec } = await import("child_process");
  const openCmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${openCmd} ${HOSTED_URL}`);
}

function syncMessage(result: import("./code-map.js").SyncResult): string {
  if (result.status === "synced" || result.status === "unchanged") return `Synced ${result.repo}: ${result.files} files`;
  if (result.status === "skipped") return `Code map not synced: ${result.reason}`;
  return `Code map not synced${result.repo ? ` for ${result.repo}` : ""}: ${result.reason} Run \`xkg map\` to try again.`;
}

function printHelp(): void {
  console.log(`
  xkg — A knowledge graph for your AI workers

  Usage:
    xkg                                                        Open xkg in your browser
    xkg serve-mcp --key KEY                                    Start the MCP server for your AI worker
    xkg setup-hooks --key KEY                                  Install inbox count hook (fast)
    xkg setup-hooks --key KEY --briefing                       Install full briefing hook (uses LLM)
    xkg setup-hooks --key KEY --vault                          Install vault hook (PreToolUse)
    xkg setup-hooks --key KEY --briefing --vault               Install both hooks
    xkg setup-git-hook --key KEY                               Record commits with an xkg-capture trailer and keep the code map fresh (any agent)
    xkg map [--key KEY]                                        Send this repo's code map now (file paths and exported names, never code)
    xkg config set agent "claude -p"                           Set which AI worker kos drives
    xkg kos --key KEY [--plan FILE]                            Implement a plan in an isolated worktree
    xkg help                                                   Show this help

    npx -y @xmu-labs/xkg@latest …                              Same CLI, via the published package

  MCP tools (via your AI worker):
    briefing          — Session-start briefing with ranked insights to apply
    generate_plan     — Turn selected captures into a full implementation plan
    list_plans        — List or read saved implementation plans
    vault_scan        — Scan all captures for relevance to current activity
    apply_stats       — Captures applied per week, and how many came with a commit
    curate            — Validate URLs and flag stale captures

  kos — implement plans with your own AI worker (model-agnostic):
    1. Tell xkg which assistant to drive (once):
         xkg config set agent "claude -p"      # or "codex exec", "aider --yes --message"
    2. Generate a plan via the generate_plan MCP tool.
    3. Run: xkg kos --key YOUR_KEY
       kos creates an isolated git worktree, hands the plan to your assistant,
       and reports the branch + the plan's Verification Checklist when done.

  Get started:
    1. Run: npx @xmu-labs/xkg
    2. Sign in with GitHub (creates your knowledge repo automatically)
    3. Set a PIN for quick mobile access
    4. Start capturing!

  Connect to Claude Code:
    claude mcp add xkg -- npx -y @xmu-labs/xkg@latest serve-mcp --key YOUR_API_KEY

  The @latest tag ensures every Claude Code session uses the most recent
  published version. serve-mcp also self-upgrades on startup as a safety net
  for users who registered without @latest.

  The hook is installed automatically when you start the MCP server.
  To upgrade to a full project briefing at session start:
    npx @xmu-labs/xkg setup-hooks --key YOUR_API_KEY --briefing

  To enable the vault (surfaces captures as you edit files — opt-in):
    npx @xmu-labs/xkg setup-hooks --key YOUR_API_KEY --vault
  `);
}

main().catch((err: unknown) => {
  console.error("Error:", err);
  process.exit(1);
});
