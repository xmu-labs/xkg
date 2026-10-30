// Self-update enforcement: ensures users always run the latest xkg CLI.
//
// Strategy: on serve-mcp startup, query npm for the latest published version.
// If behind, respawn the process via npx (see upgradeArgs) and proxy stdio.
// <name> is the package this copy was installed as: every release is published
// as both `@xmu-labs/xkg` and `mnemos-capture`, so each install updates under its own
// name. An XKG_UPGRADED=1 env var (MNEMOS_UPGRADED=1 from releases before
// 1.4.1) prevents infinite recursion.

import { readFileSync } from "fs";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { spawn } from "child_process";

const CHECK_TIMEOUT_MS = 2000;
/** The names releases are published under; anything else falls back to the first. */
export const PACKAGE_NAMES = ["@xmu-labs/xkg", "mnemos-capture"] as const;

function readOwnPackage(): { name?: string; version?: string } {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/cli/version-check.js → ../../package.json
    return JSON.parse(readFileSync(join(here, "../../package.json"), "utf-8")) as {
      name?: string;
      version?: string;
    };
  } catch {
    return {};
  }
}

export function getCurrentVersion(): string {
  return readOwnPackage().version ?? "0.0.0";
}

/** The npm name this copy was installed as, so updates come from the same name. */
export function getPackageName(): string {
  const name = readOwnPackage().name;
  return (PACKAGE_NAMES as readonly string[]).includes(name ?? "") ? name! : PACKAGE_NAMES[0];
}

export function isNewer(latest: string, current: string): boolean {
  const l = latest.split(".").map((n) => parseInt(n, 10) || 0);
  const c = current.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const lv = l[i] ?? 0;
    const cv = c[i] ?? 0;
    if (lv > cv) return true;
    if (lv < cv) return false;
  }
  return false;
}

export async function getLatestVersion(name: string): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${name}/latest`, {
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

/**
 * npx arguments that run `name@version` with `argv`. The npx project is the home directory, so
 * in a clone of xkg itself at that version npx runs the published release, not the clone's
 * own (unbuilt) bin. The child still runs in the current directory.
 */
export function upgradeArgs(name: string, version: string, argv: string[], home: string = homedir()): string[] {
  return ["--prefix", home, "-y", `${name}@${version}`, ...argv];
}

/**
 * If a newer version exists on npm, respawn `<name>@<latest>` via npx under
 * the name this copy was installed as, with the original argv, piping stdio. Returns true if the caller should stop
 * (because the child is taking over). Returns false otherwise — caller should
 * continue with normal startup.
 */
export async function maybeSelfUpgrade(): Promise<boolean> {
  // Recursion guard: the child spawned below will inherit this env var. Older
  // releases set MNEMOS_UPGRADED, and may be the parent that spawned this one.
  if (process.env.XKG_UPGRADED === "1" || process.env.MNEMOS_UPGRADED === "1") return false;

  const name = getPackageName();
  const current = getCurrentVersion();
  const latest = await getLatestVersion(name);
  if (!latest || !isNewer(latest, current)) return false;

  process.stderr.write(
    `xkg: upgrading to v${latest} (was v${current})...\n`,
  );

  const child = spawn(
    "npx",
    upgradeArgs(name, latest, process.argv.slice(2)),
    {
      stdio: "inherit",
      env: { ...process.env, XKG_UPGRADED: "1" },
    },
  );

  // Keep parent alive until the child exits, then exit with its code.
  await new Promise<void>((resolve) => {
    child.on("exit", (code) => {
      process.exit(code ?? 0);
      resolve();
    });
    child.on("error", () => {
      // If spawn itself fails, fall through and let the parent continue
      resolve();
    });
  });

  return true;
}
