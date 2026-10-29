import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, posix } from "path";

/**
 * The code map: for each tracked file of a repo, its path and the names it
 * exports, plus which other mapped files it imports. Never file contents,
 * comments or package names. It is built where the coding agent runs (any
 * agent, or none: git hooks trigger it) and sent to xkg, which uses it to say
 * where a capture applies.
 *
 * Exports are cached per git blob id in ~/.xkg/maps.json, so a rebuild reads
 * only files whose content changed. The map is sent only when its hash changed.
 */

export type MapFile = { p: string; e?: string[]; i?: string[] };
export type CodeMap = { repo: string; head7: string; files: MapFile[]; truncated: boolean };

export const MAX_FILES = 3000;
export const MAX_BYTES = 120 * 1024;
const MAP_URL = "https://xkg.xmu.sh/api/code-map";
const SYNC_TIMEOUT_MS = 3000;
/** Larger files are mapped by path only: they are almost always generated. */
const MAX_SOURCE_BYTES = 1024 * 1024;

const SKIP_DIR = /(^|\/)(node_modules|dist|build|\.next|\.nuxt|vendor|coverage|target|\.venv|venv|__pycache__|\.gradle|\.dart_tool|cdk\.out|__tests__|tests)\//;
const SKIP_FILE = /\.(test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$|_test\.go$|(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum)$|\.lockb?$|\.(png|jpe?g|gif|svg|ico|webp|avif|bmp|tiff?|mp4|mov|webm|mp3|wav|ogg|pdf|woff2?|ttf|otf|eot|zip|gz|tgz|bz2|xz|7z|rar|jar|wasm|exe|dll|so|dylib|bin|class|pyc)$/i;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

type Lang = "js" | "py" | "go" | "rs";
const JS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

function langOf(path: string): Lang | null {
  const ext = posix.extname(path).toLowerCase();
  if (JS_EXTS.includes(ext)) return "js";
  return ({ ".py": "py", ".go": "go", ".rs": "rs" } as Record<string, Lang>)[ext] ?? null;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** `owner/name` from an origin URL in any common form, without credentials. */
export function repoFromRemote(url: string): string | null {
  const path = url.trim()
    .replace(/^[a-z+]+:\/\/[^/]*\//i, "")  // scheme://user:pass@host[:port]/
    .replace(/^[^@/]+@[^:/]+:/, "")       // git@host:
    .replace(/\.git\/?$/, "")
    .replace(/\/+$/, "");
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const repo = parts.slice(-2).join("/");
  return /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : null;
}

const EXPORT_PATTERNS: Record<Lang, RegExp[]> = {
  js: [
    /^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\s*\*?|class|const|let|var|type|interface|enum|namespace)\s*([A-Za-z_$][\w$]*)/gm,
  ],
  py: [/^(?:async\s+)?def\s+([A-Za-z]\w*)/gm, /^class\s+([A-Za-z]\w*)/gm],
  go: [/^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/gm, /^type\s+([A-Z]\w*)/gm],
  rs: [/^\s*pub\s+(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|enum|trait|type)\s+([A-Za-z_]\w*)/gm],
};

/** The top-level names a file exports, in source order. Empty for languages without a pattern. */
export function exportedNames(path: string, source: string): string[] {
  const lang = langOf(path);
  if (!lang) return [];
  const found: Array<[number, string]> = [];
  for (const re of EXPORT_PATTERNS[lang]) {
    for (const m of source.matchAll(re)) found.push([m.index!, m[1]!]);
  }
  if (lang === "js") {
    for (const m of source.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
      for (const item of m[1]!.split(",")) {
        const name = item.trim().split(/\s+as\s+/).pop()?.trim() ?? "";
        if (name && name !== "default") found.push([m.index!, name]);
      }
    }
  }
  found.sort((a, b) => a[0] - b[0]);
  return [...new Set(found.map(([, name]) => name).filter((n) => IDENTIFIER.test(n)))];
}

/** Raw import specifiers of a file. Kept only in the local cache; only resolved paths are ever sent. */
function importSpecifiers(lang: Lang, source: string): string[] {
  const out: string[] = [];
  if (lang === "js") {
    for (const re of [/\bfrom\s+['"]([^'"\n]+)['"]/g, /^\s*import\s+['"]([^'"\n]+)['"]/gm, /\b(?:require|import)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g]) {
      for (const m of source.matchAll(re)) out.push(m[1]!);
    }
  } else if (lang === "py") {
    for (const m of source.matchAll(/^\s*from\s+(\.*[\w.]*)\s+import\s+([^\n#]+)/gm)) {
      const mod = m[1]!;
      out.push(mod);
      for (const name of m[2]!.replace(/[()\\]/g, "").split(",")) {
        const n = name.trim().split(/\s+as\s+/)[0]!.trim();
        if (/^\w+$/.test(n)) out.push(mod.endsWith(".") ? mod + n : `${mod}.${n}`);
      }
    }
    for (const m of source.matchAll(/^\s*import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)/gm)) {
      for (const part of m[1]!.split(",")) out.push(part.trim().split(/\s+as\s+/)[0]!);
    }
  }
  return [...new Set(out)];
}

type Alias = { prefix: string; suffix: string; wildcard: boolean; targets: string[] };
type Resolver = { aliases: Alias[]; baseUrl: string | null };

/** tsconfig/jsconfig `paths` and `baseUrl`, so `@/lib/db` resolves like the compiler does. */
function parseTsconfig(text: string): Resolver {
  let config: { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
  try {
    config = JSON.parse(stripJsonComments(text)) as typeof config;
  } catch {
    return { aliases: [], baseUrl: null };
  }
  const opts = config.compilerOptions ?? {};
  const base = opts.baseUrl ?? ".";
  const aliases: Alias[] = Object.entries(opts.paths ?? {}).map(([pattern, targets]) => {
    const star = pattern.indexOf("*");
    return {
      prefix: star === -1 ? pattern : pattern.slice(0, star),
      suffix: star === -1 ? "" : pattern.slice(star + 1),
      wildcard: star !== -1,
      targets: (Array.isArray(targets) ? targets : []).map((t) => posix.join(base, t)),
    };
  });
  return { aliases, baseUrl: opts.baseUrl !== undefined ? posix.normalize(opts.baseUrl) : null };
}

function stripJsonComments(text: string): string {
  let out = "";
  for (let i = 0, inString = false; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function jsCandidates(base: string): string[] {
  const out = [base];
  const ext = posix.extname(base);
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    const stem = base.slice(0, -ext.length);
    out.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`);
  }
  for (const e of JS_EXTS) out.push(base + e);
  for (const e of JS_EXTS) out.push(`${base}/index${e}`);
  return out;
}

function resolveJs(from: string, spec: string, files: Set<string>, resolver: Resolver): string | null {
  const bases: string[] = [];
  if (spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../")) {
    bases.push(posix.join(posix.dirname(from), spec));
  } else {
    for (const a of resolver.aliases) {
      if (a.wildcard ? spec.startsWith(a.prefix) && spec.endsWith(a.suffix) && spec.length >= a.prefix.length + a.suffix.length : spec === a.prefix) {
        const match = a.wildcard ? spec.slice(a.prefix.length, spec.length - a.suffix.length) : "";
        for (const t of a.targets) bases.push(posix.normalize(t.replace("*", match)));
      }
    }
    if (resolver.baseUrl !== null) bases.push(posix.join(resolver.baseUrl, spec));
  }
  for (const base of bases) {
    if (base.startsWith("..") || base.startsWith("/")) continue;
    const hit = jsCandidates(base).find((c) => files.has(c));
    if (hit) return hit;
  }
  return null;
}

function resolvePy(from: string, spec: string, files: Set<string>): string | null {
  const dots = /^\.*/.exec(spec)![0].length;
  const rel = spec.slice(dots).split(".").filter(Boolean).join("/");
  let roots = ["", "src"];
  if (dots > 0) {
    let dir = posix.dirname(from);
    for (let k = 1; k < dots; k++) dir = posix.dirname(dir);
    roots = [dir === "." ? "" : dir];
  }
  for (const root of roots) {
    const base = [root, rel].filter(Boolean).join("/");
    const candidates = rel ? [`${base}.py`, `${base}/__init__.py`] : [base ? `${base}/__init__.py` : "__init__.py"];
    const hit = candidates.find((c) => files.has(c));
    if (hit) return hit;
  }
  return null;
}

type BlobEntry = { e?: string[]; s?: string[]; r?: Resolver };
export type MapCache = { repos?: Record<string, { hash?: string; blobs?: Record<string, BlobEntry> }> };

/** Blob contents by id, in one `git cat-file` pass. Blobs over 1 MB come back empty. */
export function readBlobs(cwd: string, ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const sizes = execFileSync("git", ["cat-file", "--batch-check"], { cwd, input: ids.join("\n") + "\n", encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  const wanted: string[] = [];
  for (const line of sizes.split("\n")) {
    const [id, type, size] = line.split(" ");
    if (!id || type !== "blob") continue;
    if (Number(size) <= MAX_SOURCE_BYTES) wanted.push(id);
    else out.set(id, "");
  }
  if (wanted.length === 0) return out;
  const raw = execFileSync("git", ["cat-file", "--batch"], { cwd, input: wanted.join("\n") + "\n", maxBuffer: 1024 * 1024 * 1024 });
  for (let pos = 0; pos < raw.length;) {
    const nl = raw.indexOf(0x0a, pos);
    if (nl === -1) break;
    const [id, type, size] = raw.subarray(pos, nl).toString("utf-8").split(" ");
    if (type !== "blob") { pos = nl + 1; continue; }
    const len = Number(size);
    out.set(id!, raw.subarray(nl + 1, nl + 1 + len).toString("utf-8"));
    pos = nl + 1 + len + 1;
  }
  return out;
}

export interface BuildOptions {
  /** Parsed ~/.xkg/maps.json; updated in place with this build's exports. */
  cache?: MapCache;
  readBlobs?: (cwd: string, ids: string[]) => Map<string, string>;
}

/** The repo's map, or null when it has no origin remote to name it by. */
export function buildCodeMap(cwd: string, opts: BuildOptions = {}): CodeMap | null {
  let repo: string | null;
  try {
    repo = repoFromRemote(git(cwd, "remote", "get-url", "origin"));
  } catch {
    return null;
  }
  if (!repo) return null;

  const tracked = new Map<string, string>();
  const listing = execFileSync("git", ["ls-files", "-s", "-z"], { cwd, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
  for (const entry of listing.split("\0")) {
    const m = /^(\d+) ([0-9a-f]+) \d\t(.+)$/s.exec(entry);
    if (!m || m[1] === "160000" || tracked.has(m[3]!)) continue;
    tracked.set(m[3]!, m[2]!);
  }
  const paths = [...tracked.keys()].filter((p) => !SKIP_DIR.test(p) && !SKIP_FILE.test(p));
  const mapped = new Set(paths);

  const cache = opts.cache ?? {};
  cache.repos ??= {};
  const previous = cache.repos[repo]?.blobs ?? {};
  const blobs: Record<string, BlobEntry> = {};
  const keyOf = (path: string, kind: string) => `${tracked.get(path)}:${kind}`;

  const configPath = ["tsconfig.json", "jsconfig.json"].find((p) => tracked.has(p));
  const toRead = new Map<string, string>();
  for (const p of paths) {
    const lang = langOf(p);
    if (lang && !previous[keyOf(p, lang)]) toRead.set(tracked.get(p)!, p);
  }
  if (configPath && !previous[keyOf(configPath, "config")]) toRead.set(tracked.get(configPath)!, configPath);
  const contents = (opts.readBlobs ?? readBlobs)(cwd, [...toRead.keys()]);

  const entryFor = (p: string, kind: string, make: (src: string) => BlobEntry): BlobEntry => {
    const key = keyOf(p, kind);
    const entry = previous[key] ?? make(contents.get(tracked.get(p)!) ?? "");
    blobs[key] = entry;
    return entry;
  };

  const resolver = configPath
    ? entryFor(configPath, "config", (src) => ({ r: parseTsconfig(src) })).r!
    : { aliases: [], baseUrl: null };

  const files: MapFile[] = paths.map((p) => {
    const lang = langOf(p);
    if (!lang) return { p };
    const entry = entryFor(p, lang, (src) => ({ e: exportedNames(p, src), s: importSpecifiers(lang, src) }));
    const file: MapFile = { p };
    if (entry.e?.length) file.e = entry.e;
    const imports = new Set<string>();
    for (const spec of entry.s ?? []) {
      const hit = lang === "js" ? resolveJs(p, spec, mapped, resolver) : lang === "py" ? resolvePy(p, spec, mapped) : null;
      if (hit && hit !== p) imports.add(hit);
    }
    if (imports.size) file.i = [...imports];
    return file;
  });

  cache.repos[repo] = { ...cache.repos[repo], blobs };

  let head7 = "";
  try {
    head7 = git(cwd, "rev-parse", "--short=7", "HEAD");
  } catch {
    // No commit yet
  }
  return { repo, head7, ...capMap(files) };
}

const size = (files: MapFile[]) => Buffer.byteLength(JSON.stringify(files));
const depth = (p: string) => p.split("/").length;

/**
 * Fits a map in 3,000 files and 120 KB: drop imports, then exports; still
 * over, keep the shallowest paths (in their original order) and mark it truncated.
 */
export function capMap(files: MapFile[]): { files: MapFile[]; truncated: boolean } {
  if (files.length <= MAX_FILES && size(files) <= MAX_BYTES) return { files, truncated: false };
  const noImports = files.map(({ i: _i, ...rest }) => rest);
  if (files.length <= MAX_FILES && size(noImports) <= MAX_BYTES) return { files: noImports, truncated: false };
  const pathsOnly = files.map(({ p }) => ({ p }));
  if (files.length <= MAX_FILES && size(pathsOnly) <= MAX_BYTES) return { files: pathsOnly, truncated: false };

  const order = pathsOnly.map((f, n) => ({ f, n })).sort((a, b) => depth(a.f.p) - depth(b.f.p) || (a.f.p < b.f.p ? -1 : 1));
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

/** Changes only when what the server would store changes (not on every commit). */
export function mapHash(map: CodeMap): string {
  return createHash("sha256").update(JSON.stringify({ repo: map.repo, files: map.files, truncated: map.truncated })).digest("hex");
}

export type SyncResult =
  | { status: "synced"; repo: string; files: number }
  | { status: "unchanged"; repo: string; files: number }
  | { status: "failed"; repo?: string; reason: string }
  | { status: "skipped"; reason: string };

export interface SyncOptions {
  /** Send even when the map hasn't changed (the `xkg map` command). */
  force?: boolean;
  cachePath?: string;
  timeoutMs?: number;
}

function loadCache(path: string): MapCache {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as MapCache;
  } catch {
    return {};
  }
}

function saveCache(path: string, cache: MapCache): void {
  try {
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache));
  } catch {
    // The cache only saves work; a failed write costs a re-read next time
  }
}

/** Builds the map and sends it to xkg if it changed. Never throws; gives up after 3 s. */
export async function syncCodeMap(apiKey: string, cwd: string = process.cwd(), opts: SyncOptions = {}): Promise<SyncResult> {
  const cachePath = opts.cachePath ?? join(homedir(), ".xkg", "maps.json");
  try {
    const cache = loadCache(cachePath);
    const map = buildCodeMap(cwd, { cache });
    if (!map) return { status: "skipped", reason: "This repo has no origin remote, so xkg can't tell which repo it is." };
    const hash = mapHash(map);
    const entry = cache.repos![map.repo]!;
    if (!opts.force && entry.hash === hash) {
      saveCache(cachePath, cache);
      return { status: "unchanged", repo: map.repo, files: map.files.length };
    }

    let res: Response;
    try {
      res = await fetch(MAP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(map),
        signal: AbortSignal.timeout(opts.timeoutMs ?? SYNC_TIMEOUT_MS),
      });
    } catch (err) {
      saveCache(cachePath, cache);
      return { status: "failed", repo: map.repo, reason: `Could not reach xkg: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!res.ok) {
      saveCache(cachePath, cache);
      return { status: "failed", repo: map.repo, reason: `xkg answered HTTP ${res.status}.` };
    }
    entry.hash = hash;
    saveCache(cachePath, cache);
    return { status: "synced", repo: map.repo, files: map.files.length };
  } catch (err) {
    return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
}
