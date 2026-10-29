/**
 * xkg CLI config — stores which AI assistant `xkg agent` should drive, and an
 * optional API key, in ~/.xkg/config.json.
 * Falls back to ~/.xmu/config.json then ~/.mnemos/config.json.
 */

import { homedir } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";

function xkgDir(): string {
  return join(homedir(), ".xkg");
}

function xmuDir(): string {
  return join(homedir(), ".xmu");
}

function mnemosDir(): string {
  return join(homedir(), ".mnemos");
}

function xkgPath(): string {
  return join(xkgDir(), "config.json");
}

function xmuPath(): string {
  return join(xmuDir(), "config.json");
}

function mnemosPath(): string {
  return join(mnemosDir(), "config.json");
}

/** Path we currently read from: xkg, then xmu, then mnemos. */
function readPath(): string {
  if (existsSync(xkgPath())) return xkgPath();
  if (existsSync(xmuPath())) return xmuPath();
  if (existsSync(mnemosPath())) return mnemosPath();
  return xkgPath();
}

export interface XkgConfig {
  /** Shell command that launches the user's AI assistant, e.g. "claude -p". */
  agent?: string;
  /** Optional stored MCP API key so `xkg agent` can run without --key. */
  key?: string;
}

const ALLOWED_FIELDS = ["agent", "key"] as const;
type ConfigField = (typeof ALLOWED_FIELDS)[number];

export function readConfig(): XkgConfig {
  const path = readPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as XkgConfig;
  } catch {
    return {};
  }
}

export function writeConfig(cfg: XkgConfig): void {
  const dir = xkgDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(xkgPath(), JSON.stringify(cfg, null, 2) + "\n");
}

export function setConfigField(field: string, value: string): void {
  if (!ALLOWED_FIELDS.includes(field as ConfigField)) {
    throw new Error(`Unknown config field: ${field}. Allowed: ${ALLOWED_FIELDS.join(", ")}`);
  }
  const cfg = readConfig();
  cfg[field as ConfigField] = value;
  writeConfig(cfg);
}

/** Route `xkg config <set|get> ...`. */
export function runConfigCommand(args: string[]): void {
  const action = args[0];

  if (action === "set") {
    const field = args[1];
    const value = args.slice(2).join(" ");
    if (!field || !value) {
      console.error("Usage: xkg config set <field> <value>");
      console.error('  e.g. xkg config set agent "claude -p"');
      process.exit(1);
    }
    try {
      setConfigField(field, value);
      console.log(`Set ${field} = ${value}`);
      console.log(`Saved to ${xkgPath()}`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    return;
  }

  if (action === "get") {
    const cfg = readConfig();
    const field = args[1];
    if (field) {
      console.log(cfg[field as ConfigField] ?? "(not set)");
    } else {
      console.log(JSON.stringify(cfg, null, 2));
    }
    return;
  }

  console.error("Usage: xkg config set|get <field> [value]");
  process.exit(1);
}
