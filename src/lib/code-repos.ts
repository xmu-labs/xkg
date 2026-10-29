/**
 * Code repos added from Settings: when a repo has no map from the user's
 * machine, xkg reads its file paths from GitHub with the user's own sign-in.
 * Paths only: no file is opened, so no code and no exported names. A map from
 * the user's machine always wins over one read from GitHub (see saveCodeMap).
 */

import { createHash } from "crypto";
import type { CodeMapPayload, MapFile, StoredCodeMap } from "./code-map";
import { saveCodeMap } from "./db";

/** A GitHub map older than this is read again on the next capture. */
export const GITHUB_MAP_MAX_AGE_DAYS = 7;
export const GITHUB_TREE_TIMEOUT_MS = 5000;

// The same files the CLI leaves out of a local map (cli/code-map.ts); a test keeps them equal.
export const SKIP_DIR = /(^|\/)(node_modules|dist|build|\.next|\.nuxt|vendor|coverage|target|\.venv|venv|__pycache__|\.gradle|\.dart_tool|cdk\.out|__tests__|tests)\//;
export const SKIP_FILE = /\.(test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$|_test\.go$|(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum)$|\.lockb?$|\.(png|jpe?g|gif|svg|ico|webp|avif|bmp|tiff?|mp4|mov|webm|mp3|wav|ogg|pdf|woff2?|ttf|otf|eot|zip|gz|tgz|bz2|xz|7z|rar|jar|wasm|exe|dll|so|dylib|bin|class|pyc)$/i;
const MAX_FILES = 3000;
const MAX_BYTES = 120 * 1024;
const MAX_PATH_LENGTH = 512;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export type GithubMapResult = { ok: true; map: CodeMapPayload } | { ok: false; error: string };

const BAD_NAME = "Enter the repo as owner/name, for example acme/widgets.";
const NO_ANSWER = "GitHub didn't answer. Try again in a minute.";

/** `owner/name` from what the user typed (a pasted github.com URL works too), or null. */
export function repoName(input: string): string | null {
  const name = input.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  const parts = name.split("/");
  if (parts.length !== 2 || !parts.every((s) => /^[\w.-]+$/.test(s) && s !== "." && s !== "..")) return null;
  return name.length <= 200 ? name : null;
}

const depth = (p: string) => p.split("/").length;

/** Fits a paths-only map in 3,000 files and 120 KB like the CLI's capMap: the shallowest paths, in their order. */
export function capPaths(paths: string[]): { files: MapFile[]; truncated: boolean } {
  const files = paths.map((p) => ({ p }));
  if (files.length <= MAX_FILES && Buffer.byteLength(JSON.stringify(files)) <= MAX_BYTES) return { files, truncated: false };
  const order = files.map((f, n) => ({ f, n })).sort((a, b) => depth(a.f.p) - depth(b.f.p) || (a.f.p < b.f.p ? -1 : 1));
  const kept: typeof order = [];
  let bytes = 2;
  for (const item of order) {
    const add = Buffer.byteLength(JSON.stringify(item.f)) + 1;
    if (kept.length >= MAX_FILES || bytes + add > MAX_BYTES) break;
    kept.push(item);
    bytes += add;
  }
  kept.sort((a, b) => a.n - b.n);
  return { files: kept.map((k) => k.f), truncated: true };
}

/** One request: the default branch's file paths, filtered and capped like a local map. */
export async function fetchGithubMap(token: string, input: string, fetchImpl: Fetch = fetch): Promise<GithubMapResult> {
  const repo = repoName(input);
  if (!repo) return { ok: false, error: BAD_NAME };

  let res: Response;
  let body: { truncated?: unknown; tree?: unknown };
  try {
    res = await fetchImpl(`https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(GITHUB_TREE_TIMEOUT_MS),
    });
    if ([401, 403, 404].includes(res.status)) {
      return { ok: false, error: `xkg can't read ${repo} with your GitHub sign-in. Check the name, and that your account can open it.` };
    }
    if (res.status === 409) return { ok: false, error: `${repo} has no files yet.` };
    if (!res.ok) return { ok: false, error: NO_ANSWER };
    body = (await res.json()) as typeof body;
  } catch {
    return { ok: false, error: NO_ANSWER };
  }

  const entries = Array.isArray(body.tree) ? (body.tree as Array<{ path?: unknown; type?: unknown }>) : [];
  const paths = entries
    .filter((e) => e.type === "blob" && typeof e.path === "string")
    .map((e) => e.path as string)
    .filter((p) => !SKIP_DIR.test(p) && !SKIP_FILE.test(p) && p.length <= MAX_PATH_LENGTH && !/[\0\\]/.test(p));
  const capped = capPaths(paths);
  return { ok: true, map: { repo, head7: "", files: capped.files, truncated: capped.truncated || body.truncated === true } };
}

/** The hash stored with a map, as the map route computes it. */
export function codeMapHash(map: CodeMapPayload): string {
  return createHash("sha256").update(JSON.stringify({ files: map.files, truncated: map.truncated })).digest("hex");
}

interface RefreshDeps {
  fetchImpl?: Fetch;
  save?: typeof saveCodeMap;
  now?: () => Date;
}

/**
 * Before matching: reads again each GitHub map older than 7 days, one request
 * per repo, in parallel. Best-effort: on any failure the old map is used.
 */
export async function refreshStaleGithubMaps(token: string | null | undefined, userId: number, maps: StoredCodeMap[], deps: RefreshDeps = {}): Promise<StoredCodeMap[]> {
  if (!token) return maps;
  const now = (deps.now ?? (() => new Date()))();
  const save = deps.save ?? saveCodeMap;
  const stale = (m: StoredCodeMap) => m.source === "github" && now.getTime() - m.syncedAt.getTime() > GITHUB_MAP_MAX_AGE_DAYS * 86_400_000;
  return Promise.all(maps.map(async (m) => {
    if (!stale(m)) return m;
    try {
      const res = await fetchGithubMap(token, m.repo, deps.fetchImpl);
      if (!res.ok) return m;
      if (!(await save(userId, res.map, codeMapHash(res.map), "github"))) return m;
      return { ...m, files: res.map.files, head7: null, truncated: res.map.truncated, syncedAt: now };
    } catch (err) {
      console.error(`[code-repos] refresh of ${m.repo} failed:`, err instanceof Error ? err.message : err);
      return m;
    }
  }));
}
