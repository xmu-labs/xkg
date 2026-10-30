import { homedir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { createInterface } from "readline/promises";
import { AGENTS, type AgentEnv, type AgentId } from "./setup-agents.js";

/** `xkg init` and `xkg doctor` with the real machine behind their deps. */

export function parseInitArgs(args: string[]): { key?: string; yes: boolean; only?: AgentId[] } {
  const keyIdx = args.indexOf("--key");
  const agentsIdx = args.indexOf("--agents");
  let only: AgentId[] | undefined;
  if (agentsIdx !== -1) {
    const names = (args[agentsIdx + 1] ?? "").split(",").map((n) => n.trim()).filter(Boolean);
    const known = AGENTS.map((a) => a.id as string);
    const unknown = names.filter((n) => !known.includes(n));
    if (unknown.length) throw new Error(`Unknown agent: ${unknown.join(", ")}. Use: ${known.join(", ")}`);
    only = names as AgentId[];
  }
  return { key: keyIdx !== -1 ? args[keyIdx + 1] : undefined, yes: args.includes("--yes") || args.includes("-y"), only };
}

export function machineEnv(): AgentEnv {
  return {
    home: homedir(),
    onPath: (cmd) => {
      try {
        if (process.platform === "win32") execFileSync("where", [cmd], { stdio: "ignore", timeout: 3000 });
        else execFileSync("sh", ["-c", 'command -v "$1"', "sh", cmd], { stdio: "ignore", timeout: 3000 });
        return true;
      } catch {
        return false;
      }
    },
    run: (cmd, args) => {
      try {
        return { ok: true, out: execFileSync(cmd, args, { encoding: "utf-8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] }) };
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        return { ok: false, out: e.stderr || e.message || String(err) };
      }
    },
  };
}

/** checkHookConnection, worded for init and doctor rather than setup-git-hook. */
async function connect(key: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { checkHookConnection } = await import("./git-hook.js");
  const res = await checkHookConnection(key);
  return res.ok ? res : { ok: false, reason: res.reason.replace(/ Run setup-git-hook again with a current key\.$/, "") };
}

/**
 * What `xkg session-start` would print, as plain text. Without the repo, so doctor
 * doesn't ask for this repo's handoffs: the server counts that as an offer.
 */
export async function previewSessionStart(key: string): Promise<string> {
  const { sessionStart } = await import("./session-start.js");
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await sessionStart(key, { repo: null });
  } finally {
    process.stdout.write = write;
  }
  return chunks.join("");
}

async function doctor(key: string | undefined, json: boolean): Promise<boolean> {
  const { runChecks, formatChecks } = await import("./doctor.js");
  const { callMcp } = await import("./hooks.js");
  const { getCurrentVersion, getLatestVersion, getPackageName } = await import("./version-check.js");
  const checks = await runChecks({
    env: machineEnv(),
    key,
    cwd: process.cwd(),
    currentVersion: getCurrentVersion(),
    connect,
    latestVersion: () => getLatestVersion(getPackageName()),
    inbox: (k) => callMcp(k, "list_inbox", { limit: 1 }, 8000),
    preview: previewSessionStart,
    mapCachePath: join(homedir(), ".xkg", "maps.json"),
  });
  const ok = !checks.some((c) => c.status === "fail");
  if (json) console.log(JSON.stringify({ ok, checks }, null, 2));
  else {
    process.stdout.write(formatChecks(checks));
    console.log(ok ? "\n  xkg is set up." : "\n  Fix the ✗ lines above, then run doctor again.");
  }
  return ok;
}

export async function doctorCommand(args: string[]): Promise<number> {
  const { readConfig } = await import("./config.js");
  return (await doctor(readConfig().key, args.includes("--json"))) ? 0 : 1;
}

export async function initCommand(args: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseInitArgs>;
  try {
    parsed = parseInitArgs(args);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const { runInit } = await import("./init.js");
  const { readConfig, setConfigField } = await import("./config.js");
  const { installGitHooks } = await import("./git-hook.js");
  const { syncCodeMap } = await import("./code-map.js");
  const { currentRepo } = await import("./session-start.js");

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    const result = await runInit({
      env: machineEnv(),
      ...parsed,
      storedKey: readConfig().key,
      interactive,
      ask: (q) => rl!.question(q),
      log: (line) => console.log(line),
      saveKey: (k) => setConfigField("key", k),
      connect,
      repo: currentRepo(),
      installGitHooks: () => installGitHooks(),
      syncMap: async (k) => {
        const r = await syncCodeMap(k, process.cwd(), { force: true });
        return r.status === "synced" || r.status === "unchanged" ? `Code map sent: ${r.repo}, ${r.files} file${r.files === 1 ? "" : "s"}` : `Code map not sent: ${r.reason}`;
      },
      backupDir: join(homedir(), ".xkg", "backups", new Date().toISOString().replace(/[:.]/g, "-")),
    });
    if (!result.ok) return 1;
  } finally {
    rl?.close();
  }
  console.log("\nChecking the setup (xkg doctor):");
  return (await doctor(readConfig().key, false)) ? 0 : 1;
}
