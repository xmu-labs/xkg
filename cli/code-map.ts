import { createHash, createHmac } from "crypto";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, posix } from "path";

/**
 * The code map: for each tracked file of a repo, its path, the names it
 * exports and their signatures (no bodies, no default values), which other
 * mapped files it imports, and the first sentence of the file's leading doc
 * comment. Never code, other comments or package names. It is built where the coding agent runs (any
 * agent, or none: git hooks trigger it) and sent to xkg, which uses it to say
 * where a capture applies.
 *
 * Exports are cached per git blob id in ~/.xkg/maps.json, so a rebuild reads
 * only files whose content changed. The map is sent only when its hash changed.
 */

/** p path, e exported names, i mapped imports, d doc line, g signatures. */
export type MapFile = { p: string; e?: string[]; i?: string[]; d?: string; g?: string[] };
export type CodeMap = { repo: string; head7: string; files: MapFile[]; truncated: boolean };

export const MAX_FILES = 3000;
export const MAX_BYTES = 120 * 1024;
const MAP_URL = "https://xkg.xmu.sh/api/code-map";
const SYNC_TIMEOUT_MS = 3000;
const RESEND_AFTER_MS = 24 * 60 * 60 * 1000;
/** Bump when what is read from a file changes, so entries cached by an older CLI are read again. */
const CACHE_VERSION = 3;
/** Larger files are mapped by path only: they are almost always generated. */
const MAX_SOURCE_BYTES = 1024 * 1024;
/** Bytes of file contents read at once; each batch's names are taken before the next is read. */
const BLOB_BATCH_BYTES = 32 * 1024 * 1024;

export const SKIP_DIR = /(^|\/)(node_modules|dist|build|\.next|\.nuxt|vendor|coverage|target|\.venv|venv|__pycache__|\.gradle|\.dart_tool|cdk\.out|__tests__|tests)\//;
export const SKIP_FILE = /\.(test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$|_test\.go$|(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum)$|\.lockb?$|\.(png|jpe?g|gif|svg|ico|webp|avif|bmp|tiff?|mp4|mov|webm|mp3|wav|ogg|pdf|woff2?|ttf|otf|eot|zip|gz|tgz|bz2|xz|7z|rar|jar|wasm|exe|dll|so|dylib|bin|class|pyc)$/i;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
// The server's limits per file (src/lib/code-map.ts): a file over them would
// make it refuse the whole map.
const MAX_EXPORTS_PER_FILE = 1000;
const MAX_NAME_LENGTH = 200;
const MAX_PATH_LENGTH = 512;
export const MAX_DOC_LINE = 200;
export const MAX_SIGNATURE = 160;
export const MAX_SIGNATURES_PER_FILE = 30;

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

// Line-start patterns use [ \t]*, never \s*: comments are blanked to spaces
// first, and \s* would rescan every blank line below from each line start.
const EXPORT_PATTERNS: Record<Lang, RegExp[]> = {
  js: [
    /^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\s*\*?|class|const|let|var|type|interface|enum|namespace)\s*([A-Za-z_$][\w$]*)/gm,
  ],
  py: [/^(?:async\s+)?def\s+([A-Za-z]\w*)/gm, /^class\s+([A-Za-z]\w*)/gm],
  go: [/^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/gm, /^type\s+([A-Z]\w*)/gm],
  rs: [/^[ \t]*pub\s+(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|enum|trait|type)\s+([A-Za-z_]\w*)/gm],
};

type Syntax = { line: string; block: boolean; multi: string[]; single: string[]; char?: RegExp };
const SYNTAX: Record<Lang, Syntax> = {
  js: { line: "//", block: true, multi: ["`"], single: ["'", '"'] },
  py: { line: "#", block: false, multi: ['"""', "'''"], single: ["'", '"'] },
  go: { line: "//", block: true, multi: ["`"], single: ["'", '"'] },
  // ' starts a char ('"') or a lifetime ('a), so only a whole char is skipped.
  rs: { line: "//", block: true, multi: ['"'], single: [], char: /'(?:\\.[^']*|[^\\'])'/y },
};

/**
 * The source with comments and multi-line strings blanked (newlines kept), so a
 * declaration or import in a comment or docstring is not taken for a real one.
 * Single-line strings are kept, since import paths are in them. Regex literals
 * are not parsed: one with a quote or backtick can blank code until the next.
 */
function maskComments(lang: Lang, source: string): string {
  const { line, block, multi, single, char } = SYNTAX[lang];
  const out = source.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  for (let i = 0; i < source.length;) {
    const c = source[i]!;
    let end = -1;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (char) {
      char.lastIndex = i;
      if (char.test(source)) {
        i = char.lastIndex;
        continue;
      }
    }
    if (source.startsWith(line, i)) {
      end = source.indexOf("\n", i);
    } else if (block && source.startsWith("/*", i)) {
      end = source.indexOf("*/", i + 2);
      if (end >= 0) end += 2;
    } else {
      const quote = multi.find((q) => source.startsWith(q, i));
      if (quote) {
        let j = i + quote.length;
        while (j < source.length && !source.startsWith(quote, j)) j += source[j] === "\\" ? 2 : 1;
        end = Math.min(source.length, j + quote.length);
      } else if (single.includes(c)) {
        let j = i + 1;
        while (j < source.length && source[j] !== c && source[j] !== "\n") j += source[j] === "\\" ? 2 : 1;
        i = j + 1;
        continue;
      } else {
        i++;
        continue;
      }
    }
    if (end < 0) end = source.length;
    blank(i, end);
    i = end;
  }
  return out.join("");
}

/** The top-level names a file exports, in source order. Empty for languages without a pattern. */
export function exportedNames(path: string, source: string): string[] {
  const lang = langOf(path);
  if (!lang) return [];
  source = maskComments(lang, source);
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
  return [...new Set(found.map(([, name]) => name).filter((n) => IDENTIFIER.test(n) && n.length <= MAX_NAME_LENGTH))].slice(0, MAX_EXPORTS_PER_FILE);
}

// A leading comment that is a license, a tool directive or an editor mode line
// says nothing about what the file does.
const NOT_A_DESCRIPTION = /^(copyright|\(c\)|©|license|licensed|spdx-|eslint|prettier|biome-|tslint|jshint|global\s|istanbul|c8\s|@ts-|@flow|-\*-|vim:)/i;

/**
 * The first sentence of the doc comment a file opens with, on one line, or
 * null. Only a comment before any code is read: a shebang, "use client"-style
 * directives and license or lint comments are skipped; JSDoc tags are dropped.
 */
export function docLine(path: string, source: string): string | null {
  const lang = langOf(path);
  if (!lang) return null;
  let s = source.replace(/^\uFEFF/, "").replace(/^#![^\n]*\n/, "");
  for (let blocks = 0; blocks < 5; blocks++) {
    s = s.replace(/^\s+/, "");
    const directive = /^(['"])use [a-z ]+\1;?/.exec(s);
    if (lang === "js" && directive) {
      s = s.slice(directive[0].length);
      continue;
    }
    let text: string;
    if (lang === "py") {
      const hash = /^#[^\n]*/.exec(s);
      if (hash) {
        s = s.slice(hash[0].length);
        continue;
      }
      const doc = /^[rRuU]?("""|''')([\s\S]*?)\1/.exec(s);
      if (!doc) return null;
      text = doc[2]!;
      s = s.slice(doc[0].length);
    } else {
      const block = /^\/\*([\s\S]*?)\*\//.exec(s);
      const lines = block ? null : /^(?:[ \t]*\/\/[^\n]*(?:\n|$))+/.exec(s);
      if (block) text = block[1]!.replace(/^[ \t]*\*+[ \t]?/gm, "").replace(/^\*+/, "");
      else if (lines) text = lines[0].replace(/^[ \t]*\/\/[/!]?[ \t]?/gm, "");
      else return null;
      s = s.slice((block ?? lines)![0].length);
    }
    const untagged: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trim().startsWith("@")) break;
      untagged.push(line);
    }
    const flat = untagged.join(" ").replace(/\s+/g, " ").trim();
    if (!flat || NOT_A_DESCRIPTION.test(flat)) continue;
    const first = flat.split(/(?<=[.!?])\s/)[0]!;
    return first.length <= MAX_DOC_LINE ? first : first.slice(0, MAX_DOC_LINE).trimEnd();
  }
  return null;
}

// "= (a: T): R =>", "= async x =>": the value is an arrow function, so its
// parameters are part of the signature. Anything else after "=" is a value.
const ARROW_VALUE = /^=\s*(?:async\s+)?(?:<[^<>]*>\s*)?(?:\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)|[A-Za-z_$][\w$]*)\s*(?::[^=;{]+?)?\s*=>/;

/**
 * One declaration's head, from its start to where its body or value begins:
 * name, parameters and types. Default values are left out, so no literal from
 * the code leaves the machine with it.
 */
function signatureAt(lang: Lang, src: string, start: number): string {
  const quotes = lang === "rs" || lang === "go" ? ['"'] : ['"', "'", "`"];
  const OPEN = "([{<";
  const CLOSE: Record<string, string> = { ")": "(", "]": "[", "}": "{", ">": "<" };
  const stack: string[] = [];
  let out = "";
  let skipFrom = -1; // stack depth of the default value being skipped
  let arrowValue = false; // a const holding an arrow function: its "=>" ends the signature
  for (let i = start; i < src.length && out.length < 600; i++) {
    const c = src[i]!;
    const two = src.slice(i, i + 2);
    const skipping = skipFrom >= 0;
    if (quotes.includes(c)) {
      // A string's contents never leave the machine, even in a type.
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      if (!skipping) out += `${c}…${c}`;
      i = j;
      continue;
    }
    if (two === "=>" || two === "->") {
      i++;
      if (skipping) continue;
      out += two;
      if (stack.length === 0 && two === "=>" && arrowValue) break;
      continue;
    }
    // Inside a default value, < and > are comparisons, not generics (but a ">"
    // still closes the type parameter list a default sits in, as in <T = unknown>).
    if (OPEN.includes(c) && !(c === "<" && skipping)) {
      if (c === "{" && stack.length === 0) break;
      stack.push(c);
    } else if (CLOSE[c] && !(c === ">" && (stack.at(-1) !== "<" || (skipping && stack.length !== skipFrom)))) {
      if (stack.at(-1) === CLOSE[c]) stack.pop();
      if (skipping && stack.length < skipFrom) skipFrom = -1;
    }
    if (skipFrom >= 0) {
      if (c === "," && stack.length === skipFrom) skipFrom = -1;
      else continue;
    }
    if (stack.length === 0) {
      if (c === ";" || (c === ":" && lang === "py") || (c === "\n" && lang !== "js")) break;
      if (c === "=" && src[i + 1] !== "=") {
        // A const holding an arrow function keeps its parameters; any other value ends the signature.
        if (lang === "js" && ARROW_VALUE.test(src.slice(i, i + 400))) {
          out += c;
          arrowValue = true;
          continue;
        }
        break;
      }
    } else if (c === "=" && src[i + 1] !== "=" && !skipping) {
      skipFrom = stack.length;
      continue;
    }
    out += c;
  }
  const flat = out
    .replace(/\s+/g, " ")
    .replace(/\(\s/g, "(")
    .replace(/\s+([,)>\]])/g, "$1")
    .replace(/,\s*\)/g, ")")
    .trim()
    .replace(/^export\s+(?:default\s+)?(?:declare\s+)?/, "")
    .replace(/^pub\s+/, "");
  return flat.length <= MAX_SIGNATURE ? flat : flat.slice(0, MAX_SIGNATURE).trimEnd();
}

/** Signatures of the top-level declarations a file exports, in source order, at most 30. */
export function signatures(path: string, source: string): string[] {
  const lang = langOf(path);
  if (!lang) return [];
  const masked = maskComments(lang, source);
  const starts: number[] = [];
  for (const re of EXPORT_PATTERNS[lang]) {
    for (const m of masked.matchAll(re)) starts.push(m.index! + (/^[ \t]*/.exec(m[0])?.[0].length ?? 0));
  }
  const out: string[] = [];
  for (const at of [...new Set(starts)].sort((a, b) => a - b)) {
    const sig = signatureAt(lang, masked, at);
    if (sig && !out.includes(sig)) out.push(sig);
    if (out.length === MAX_SIGNATURES_PER_FILE) break;
  }
  return out;
}

/** Raw import specifiers of a file. Kept only in the local cache; only resolved paths are ever sent. */
function importSpecifiers(lang: Lang, source: string): string[] {
  source = maskComments(lang, source);
  const out: string[] = [];
  if (lang === "js") {
    for (const re of [/\bfrom\s+['"]([^'"\n]+)['"]/g, /^[ \t]*import\s+['"]([^'"\n]+)['"]/gm, /\b(?:require|import)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g]) {
      for (const m of source.matchAll(re)) out.push(m[1]!);
    }
  } else if (lang === "py") {
    for (const m of source.matchAll(/^[ \t]*from\s+(\.*[\w.]*)\s+import\s+([^\n#]+)/gm)) {
      const mod = m[1]!;
      out.push(mod);
      for (const name of m[2]!.replace(/[()\\]/g, "").split(",")) {
        const n = name.trim().split(/\s+as\s+/)[0]!.trim();
        if (/^\w+$/.test(n)) out.push(mod.endsWith(".") ? mod + n : `${mod}.${n}`);
      }
    }
    for (const m of source.matchAll(/^[ \t]*import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)/gm)) {
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

// The sources the TypeScript compiler tries for an import that names a
// JavaScript extension, in its order (tryAddingExtensions).
const TS_SOURCES: Record<string, string[]> = { ".js": [".ts", ".tsx"], ".jsx": [".tsx", ".ts"], ".mjs": [".mts"], ".cjs": [".cts"] };

/** Files an import of `base` can mean; from a TypeScript file, `./b.js` means b.ts first, as the compiler resolves it. */
function jsCandidates(base: string, fromTs: boolean): string[] {
  const out = [base];
  const ext = posix.extname(base);
  if (TS_SOURCES[ext]) {
    const stem = base.slice(0, -ext.length);
    const source = TS_SOURCES[ext].map((e) => stem + e);
    if (fromTs) out.unshift(...source);
    else out.push(...source);
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
    // One alias applies, as in the compiler (matchPatternOrExact): an exact
    // pattern, else the wildcard with the longest prefix, the first on a tie.
    const best =
      resolver.aliases.find((a) => !a.wildcard && spec === a.prefix) ??
      resolver.aliases
        .filter((a) => a.wildcard && spec.startsWith(a.prefix) && spec.endsWith(a.suffix) && spec.length >= a.prefix.length + a.suffix.length)
        .reduce<Alias | undefined>((b, a) => (!b || a.prefix.length > b.prefix.length ? a : b), undefined);
    if (best) {
      const match = best.wildcard ? spec.slice(best.prefix.length, spec.length - best.suffix.length) : "";
      for (const t of best.targets) bases.push(posix.normalize(t.replaceAll("*", match)));
    }
    if (resolver.baseUrl !== null) bases.push(posix.join(resolver.baseUrl, spec));
  }
  for (const base of bases) {
    if (base.startsWith("..") || base.startsWith("/")) continue;
    const hit = jsCandidates(base, /\.[mc]?tsx?$/.test(from)).find((c) => files.has(c));
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

type BlobEntry = { e?: string[]; s?: string[]; r?: Resolver; d?: string | null; g?: string[] };
export type MapCache = { repos?: Record<string, { hash?: string; sentAt?: number; blobs?: Record<string, BlobEntry> }> };

/**
 * Blob contents by id, a batch at a time, each batch at most `budget` bytes.
 * Blobs over 1 MB come back empty, in the first batch.
 */
export function* readBlobBatches(cwd: string, ids: string[], budget = BLOB_BATCH_BYTES): Generator<Map<string, string>> {
  if (ids.length === 0) return;
  const sizes = execFileSync("git", ["cat-file", "--batch-check"], { cwd, input: ids.join("\n") + "\n", encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  const skipped = new Map<string, string>();
  const batches: string[][] = [];
  let bytes = Infinity;
  for (const line of sizes.split("\n")) {
    const [id, type, size] = line.split(" ");
    if (!id || type !== "blob") continue;
    const len = Number(size);
    if (len > MAX_SOURCE_BYTES) { skipped.set(id, ""); continue; }
    if (bytes + len > budget) { batches.push([]); bytes = 0; }
    batches.at(-1)!.push(id);
    bytes += len;
  }
  if (skipped.size) yield skipped;
  for (const batch of batches) {
    const raw = execFileSync("git", ["cat-file", "--batch"], { cwd, input: batch.join("\n") + "\n", maxBuffer: budget + MAX_SOURCE_BYTES + batch.length * 128 });
    const out = new Map<string, string>();
    for (let pos = 0; pos < raw.length;) {
      const nl = raw.indexOf(0x0a, pos);
      if (nl === -1) break;
      const [id, type, size] = raw.subarray(pos, nl).toString("utf-8").split(" ");
      if (type !== "blob") { pos = nl + 1; continue; }
      const len = Number(size);
      out.set(id!, raw.subarray(nl + 1, nl + 1 + len).toString("utf-8"));
      pos = nl + 1 + len + 1;
    }
    yield out;
  }
}

export interface BuildOptions {
  /** Parsed ~/.xkg/maps.json; updated in place with this build's exports. */
  cache?: MapCache;
  readBlobs?: (cwd: string, ids: string[]) => Iterable<Map<string, string>>;
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
  // Paths are relative to the repo root wherever the command runs.
  cwd = git(cwd, "rev-parse", "--show-toplevel");

  const tracked = new Map<string, string>();
  const listing = execFileSync("git", ["ls-files", "-s", "-z"], { cwd, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
  for (const entry of listing.split("\0")) {
    const m = /^(\d+) ([0-9a-f]+) \d\t(.+)$/s.exec(entry);
    if (!m || m[1] === "160000" || tracked.has(m[3]!)) continue;
    tracked.set(m[3]!, m[2]!);
  }
  // Paths the server refuses (see parseCodeMap) would fail the whole map.
  const paths = [...tracked.keys()].filter((p) =>
    !SKIP_DIR.test(p) && !SKIP_FILE.test(p) && p.length <= MAX_PATH_LENGTH && !p.includes("\\"));
  const mapped = new Set(paths);

  const cache = opts.cache ?? {};
  cache.repos ??= {};
  const previous = cache.repos[repo]?.blobs ?? {};
  const blobs: Record<string, BlobEntry> = {};
  const keyOf = (path: string, kind: string) => `${tracked.get(path)}:${kind}:${CACHE_VERSION}`;

  const configPath = ["tsconfig.json", "jsconfig.json"].find((p) => tracked.has(p));
  // Files not in the cache, by blob id. Names are taken from each batch of
  // contents before the next is read, so a large repo never sits in memory at once.
  const toRead = new Map<string, { key: string; make: (src: string) => BlobEntry }[]>();
  const need = (p: string, kind: string, make: (src: string) => BlobEntry) => {
    const key = keyOf(p, kind);
    if (previous[key]) return;
    const id = tracked.get(p)!;
    toRead.set(id, [...(toRead.get(id) ?? []), { key, make }]);
  };
  for (const p of paths) {
    const lang = langOf(p);
    if (lang) need(p, lang, (src) => ({ e: exportedNames(p, src), s: importSpecifiers(lang, src), d: docLine(p, src), g: signatures(p, src) }));
  }
  if (configPath) need(configPath, "config", (src) => ({ r: parseTsconfig(src) }));
  const fresh: Record<string, BlobEntry> = {};
  for (const batch of (opts.readBlobs ?? readBlobBatches)(cwd, [...toRead.keys()])) {
    for (const [id, src] of batch) for (const { key, make } of toRead.get(id) ?? []) fresh[key] ??= make(src);
  }
  for (const jobs of toRead.values()) for (const { key, make } of jobs) fresh[key] ??= make("");

  const entryFor = (p: string, kind: string): BlobEntry => {
    const key = keyOf(p, kind);
    const entry = previous[key] ?? fresh[key]!;
    blobs[key] = entry;
    return entry;
  };

  const resolver = configPath ? entryFor(configPath, "config").r! : { aliases: [], baseUrl: null };

  const files: MapFile[] = paths.map((p) => {
    const lang = langOf(p);
    if (!lang) return { p };
    const entry = entryFor(p, lang);
    const file: MapFile = { p };
    if (entry.e?.length) file.e = entry.e;
    const imports = new Set<string>();
    for (const spec of entry.s ?? []) {
      const hit = lang === "js" ? resolveJs(p, spec, mapped, resolver) : lang === "py" ? resolvePy(p, spec, mapped) : null;
      if (hit && hit !== p) imports.add(hit);
    }
    if (imports.size) file.i = [...imports];
    if (entry.d) file.d = entry.d;
    if (entry.g?.length) file.g = entry.g;
    return file;
  });

  cache.repos[repo] = { ...cache.repos[repo], blobs };

  let head7 = "";
  try {
    // --short can return more than 7 characters; the server takes exactly 7.
    head7 = git(cwd, "rev-parse", "HEAD").slice(0, 7);
  } catch {
    // No commit yet
  }
  return { repo, head7, ...capMap(files) };
}

const size = (files: MapFile[]) => Buffer.byteLength(JSON.stringify(files));
const depth = (p: string) => p.split("/").length;

/**
 * Fits a map in 3,000 files and 120 KB: drop signatures, then doc lines, then
 * imports, then exports; still over, keep the shallowest paths (in their
 * original order) and mark it truncated.
 */
export function capMap(files: MapFile[]): { files: MapFile[]; truncated: boolean } {
  if (files.length <= MAX_FILES && size(files) <= MAX_BYTES) return { files, truncated: false };
  const noSignatures = files.map(({ g: _g, ...rest }) => rest);
  if (files.length <= MAX_FILES && size(noSignatures) <= MAX_BYTES) return { files: noSignatures, truncated: false };
  const noDocs = noSignatures.map(({ d: _d, ...rest }) => rest);
  if (files.length <= MAX_FILES && size(noDocs) <= MAX_BYTES) return { files: noDocs, truncated: false };
  const noImports = noDocs.map(({ i: _i, ...rest }) => rest);
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
    if (!map) {
      let inRepo = true;
      try {
        git(cwd, "rev-parse", "--is-inside-work-tree");
      } catch {
        inRepo = false;
      }
      return {
        status: "skipped",
        reason: inRepo
          ? "This repo has no origin remote, so xkg can't tell which repo it is."
          : "Not a git repository. Run this inside the repo you code in.",
      };
    }
    // The server keeps a map per account, so a new key means a new upload.
    // Keying the stamp with the API key changes it per account without storing the key.
    const hash = createHmac("sha256", apiKey).update(mapHash(map)).digest("hex");
    const entry = cache.repos![map.repo]!;
    // Re-send daily so the server's copy stays fresh and comes back if it was dropped.
    if (!opts.force && entry.hash === hash && Date.now() - (entry.sentAt ?? 0) < RESEND_AFTER_MS) {
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
    entry.sentAt = Date.now();
    saveCache(cachePath, cache);
    return { status: "synced", repo: map.repo, files: map.files.length };
  } catch (err) {
    return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
}
