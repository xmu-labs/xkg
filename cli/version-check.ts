// Self-update enforcement: ensures users always run the latest xkg CLI.
//
// Strategy: on serve-mcp startup, query npm for the latest published version.
// If behind, respawn the process via `npx -y mnemos-capture@latest` and proxy
// stdio. An XKG_UPGRADED=1 env var (MNEMOS_UPGRADED=1 from releases before
// 1.4.1) prevents infinite recursion.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { spawn } from "child_process";

const NPM_REGISTRY = "https://registry.npmjs.org/mnemos-capture/latest";
const CHECK_TIMEOUT_MS = 2000;

export function getCurrentVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/cli/version-check.js → ../../package.json
    const pkg = JSON.parse(readFileSync(join(here, "../../package.json"), "utf-8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
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

async function getLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(NPM_REGISTRY, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

/**
 * If a newer version exists on npm, respawn via `npx -y mnemos-capture@latest`
 * with the original argv, piping stdio. Returns true if the caller should stop
 * (because the child is taking over). Returns false otherwise — caller should
 * continue with normal startup.
 */
export async function maybeSelfUpgrade(): Promise<boolean> {
  // Recursion guard: the child spawned below will inherit this env var. Older
  // releases set MNEMOS_UPGRADED, and may be the parent that spawned this one.
  if (process.env.XKG_UPGRADED === "1" || process.env.MNEMOS_UPGRADED === "1") return false;

  const current = getCurrentVersion();
  const latest = await getLatestVersion();
  if (!latest || !isNewer(latest, current)) return false;

  process.stderr.write(
    `xkg: upgrading to v${latest} (was v${current})...\n`,
  );

  const child = spawn(
    "npx",
    ["-y", `mnemos-capture@${latest}`, ...process.argv.slice(2)],
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
