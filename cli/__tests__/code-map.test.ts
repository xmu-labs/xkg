import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { execFileSync } from "child_process";

// git gives a longer prefix than asked when the short one is ambiguous; a test
// turns this on to stand in for a repo with such a commit.
const abbrev = vi.hoisted(() => ({ ambiguous: false }));
vi.mock("child_process", async (orig) => {
  const real = await orig<typeof import("child_process")>();
  const execFileSync = ((cmd: string, args: readonly string[], opts: object) => {
    const out = real.execFileSync(cmd, args, opts);
    if (!abbrev.ambiguous || cmd !== "git" || !args.some((a) => a.startsWith("--short"))) return out;
    const sha = real.execFileSync("git", ["rev-parse", "HEAD"], { ...opts, encoding: "utf-8" }).trim();
    return `${sha.slice(0, 9)}\n`;
  }) as typeof real.execFileSync;
  return { ...real, execFileSync };
});
import { tmpdir } from "os";
import { join, dirname } from "path";

/**
 * The code map: file paths and exported names from a repo, never code. It is
 * built where the coding agent runs and synced to xkg so a capture can say
 * where it applies.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function makeRepo(files: Record<string, string>, origin: string | null = "git@github.com:acme/widgets.git"): string {
  const dir = mkdtempSync(join(tmpdir(), "xkg-code-map-"));
  git(dir, "init", "-q");
  if (origin) git(dir, "remote", "add", "origin", origin);
  write(dir, files);
  return dir;
}

function write(dir: string, files: Record<string, string>): void {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  git(dir, "add", "-A");
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

describe("repoFromRemote", () => {
  // protects: the repo id the server keys maps by; fails_when: a remote form maps to the wrong owner/name or keeps a credential; no_claim: hosts other than the ones listed
  it.each([
    ["git@github.com:acme/widgets.git", "acme/widgets"],
    ["https://github.com/acme/widgets", "acme/widgets"],
    ["https://x-access-token:s3cret@github.com/acme/widgets.git", "acme/widgets"],
    ["ssh://git@github.com/acme/widgets.git", "acme/widgets"],
    ["http://local_proxy@127.0.0.1:41393/git/acme/widgets", "acme/widgets"],
    ["https://gitlab.com/group/sub/widgets.git", "sub/widgets"],
  ])("%s → %s", async (remote, want) => {
    const { repoFromRemote } = await import("../code-map.js");
    expect(repoFromRemote(remote)).toBe(want);
  });

  it("returns null for something that is not a repo URL", async () => {
    const { repoFromRemote } = await import("../code-map.js");
    expect(repoFromRemote("")).toBeNull();
    expect(repoFromRemote("widgets")).toBeNull();
  });
});

describe("exportedNames", () => {
  // protects: only public names leave the machine; fails_when: a private, indented or commented name is sent, or a public one is missed; no_claim: every export syntax of each language
  it("reads top-level exports from TypeScript, in source order", async () => {
    const { exportedNames } = await import("../code-map.js");
    const src = [
      "// export function commented() {}",
      'const s = "export function fake() {}";',
      "export function foo() {}",
      "export async function bar() {}",
      "export const BAZ = 1;",
      "export default class Qux {}",
      "export type T = string;",
      "export interface I {}",
      "export enum E { A }",
      "export { a, b as c };",
      "export default function () {}",
      "namespace N {",
      "  export function inner() {}",
      "}",
    ].join("\n");
    expect(exportedNames("src/x.ts", src)).toEqual(["foo", "bar", "BAZ", "Qux", "T", "I", "E", "a", "c"]);
  });

  it("reads Python top-level defs and classes, not private or nested ones", async () => {
    const { exportedNames } = await import("../code-map.js");
    const src = "def run():\n    pass\nasync def fetch_all():\n    pass\nclass Store:\n    def method(self):\n        pass\ndef _private():\n    pass\n";
    expect(exportedNames("app/main.py", src)).toEqual(["run", "fetch_all", "Store"]);
  });

  it("reads Go capitalized funcs, methods and types", async () => {
    const { exportedNames } = await import("../code-map.js");
    const src = "func Handle(w http.ResponseWriter) {}\nfunc (s *Server) Start() {}\nfunc helper() {}\ntype Config struct{}\ntype internal int\n";
    expect(exportedNames("main.go", src)).toEqual(["Handle", "Start", "Config"]);
  });

  it("reads Rust pub items, not crate-private ones", async () => {
    const { exportedNames } = await import("../code-map.js");
    const src = "pub fn parse() {}\npub async fn load() {}\npub struct Map;\nfn private() {}\npub(crate) fn hidden() {}\n";
    expect(exportedNames("src/lib.rs", src)).toEqual(["parse", "load", "Map"]);
  });

  // protects: the no-comments promise; fails_when: a declaration inside a block comment, docstring or multi-line string is sent, or a real one after a comment-like string is missed; no_claim: regex literals with unescaped quotes or backticks
  it("skips declarations inside comments, docstrings and multi-line strings", async () => {
    const { exportedNames } = await import("../code-map.js");
    const ts = [
      "/*",
      "export function removedInternalEndpoint() {}",
      "*/",
      "const doc = `",
      "export function inTemplate() {}",
      "`;",
      'const glob = "src/**/*.ts";',
      "export function afterGlob() {}",
      "const re = /\\/\\*/;",
      "export function afterRegex() {}",
    ].join("\n");
    expect(exportedNames("src/x.ts", ts)).toEqual(["afterGlob", "afterRegex"]);
    const py = '"""Usage:\n\ndef fictitious():\n    pass\n"""\nx = "# not a comment"\ndef real():\n    pass\n\'\'\'\nclass Hidden:\n\'\'\'\n';
    expect(exportedNames("app/main.py", py)).toEqual(["real"]);
    const go = "/*\nfunc Removed() {}\n*/\nvar s = `\nfunc InRaw() {}\n`\nfunc Real() {}\n";
    expect(exportedNames("main.go", go)).toEqual(["Real"]);
    const rs = '/*\npub fn removed() {}\n*/\nconst S: &str = "\npub fn in_string() {}\n";\npub fn real() {}\nfn quote<\'a>(c: char) -> bool { c == \'"\' || c == \'\\\'\' }\npub fn after_chars() {}\n';
    expect(exportedNames("src/lib.rs", rs)).toEqual(["real", "after_chars"]);
  });

  it("reads nothing from other files", async () => {
    const { exportedNames } = await import("../code-map.js");
    expect(exportedNames("README.md", "export function looksLikeCode() {}")).toEqual([]);
  });
});

const FIXTURE: Record<string, string> = {
  "README.md": "# Widgets\n",
  "tsconfig.json": '{\n  // aliases\n  "$schema": "https://json.schemastore.org/tsconfig",\n  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } }\n}\n',
  "src/lib/llm.ts": 'import OpenAI from "openai";\nimport { segment } from "./text.js";\nimport { db } from "@/lib/db";\nimport x from "./missing";\nexport function callModel() { return "secret prompt text"; }\n',
  "src/lib/text.ts": "export const segment = () => 1;\n",
  "src/lib/db.ts": "export const db = {};\n",
  "src/lib/llm.test.ts": "export function notMapped() {}\n",
  "src/__tests__/a.ts": "export function notMappedEither() {}\n",
  "tests/e2e/flow.ts": "export function e2e() {}\n",
  "vendor/lib.js": "export function vendored() {}\n",
  "dist/out.js": "export function built() {}\n",
  "package-lock.json": "{}\n",
  "public/logo.png": "PNG",
  "app/__init__.py": "",
  "app/main.py": "from .util import helper\nimport requests\n\ndef main():\n    pass\n",
  "app/util.py": "def helper():\n    pass\n",
};

describe("buildCodeMap", () => {
  let repo: string;
  beforeEach(() => { repo = makeRepo(FIXTURE); });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  // protects: what the map holds; fails_when: a skipped file is mapped, an export or internal import is missed, or a package/missing import is sent; no_claim: import forms beyond the fixture
  it("maps tracked files with their exports and internal imports, skipping tests, build output, vendored code, lockfiles and media", async () => {
    const { buildCodeMap } = await import("../code-map.js");
    const map = buildCodeMap(repo);
    expect(map).toMatchObject({ repo: "acme/widgets", truncated: false });
    expect(map!.files).toEqual([
      { p: "README.md" },
      { p: "app/__init__.py" },
      { p: "app/main.py", e: ["main"], i: ["app/util.py"] },
      { p: "app/util.py", e: ["helper"] },
      { p: "src/lib/db.ts", e: ["db"] },
      { p: "src/lib/llm.ts", e: ["callModel"], i: ["src/lib/text.ts", "src/lib/db.ts"] },
      { p: "src/lib/text.ts", e: ["segment"] },
      { p: "tsconfig.json" },
    ]);
  });

  // protects: links are real imports; fails_when: an import inside a comment becomes a link; no_claim: imports inside strings
  it("links no imports that are commented out", async () => {
    write(repo, { "src/lib/old.ts": '/*\nimport { db } from "./db";\n*/\n// import { segment } from "./text.js";\nexport const old = 1;\n' });
    const { buildCodeMap } = await import("../code-map.js");
    expect(buildCodeMap(repo)!.files.find((f) => f.p === "src/lib/old.ts")).toEqual({ p: "src/lib/old.ts", e: ["old"] });
  });

  // protects: links point at source, as the TypeScript compiler resolves them; fails_when: a .ts file importing "./b.js" links the emitted b.js while b.ts is tracked, or a .js file links b.ts; no_claim: moduleResolution modes beyond extension substitution
  it("links a TypeScript import to the .ts source when the emitted .js is also tracked", async () => {
    write(repo, {
      "src/b.ts": "export const b = 1;\n",
      "src/b.js": "export const b = 1;\n",
      "src/a.ts": 'import { b } from "./b.js";\nexport const a = b;\n',
      "src/c.js": 'import { b } from "./b.js";\nexport const c = b;\n',
    });
    const { buildCodeMap } = await import("../code-map.js");
    const files = buildCodeMap(repo)!.files;
    expect(files.find((f) => f.p === "src/a.ts")?.i).toEqual(["src/b.ts"]);
    expect(files.find((f) => f.p === "src/c.js")?.i).toEqual(["src/b.js"]);
  });

  // protects: the names-only promise; fails_when: any value in the payload is file content; no_claim: nothing about the server's own check
  it("sends no file contents: every value is a tracked path or an identifier", async () => {
    const { buildCodeMap } = await import("../code-map.js");
    const map = buildCodeMap(repo)!;
    const tracked = new Set(git(repo, "ls-files").split("\n"));
    for (const f of map.files) {
      expect(tracked.has(f.p)).toBe(true);
      for (const name of f.e ?? []) expect(name).toMatch(IDENTIFIER);
      for (const path of f.i ?? []) expect(map.files.some((g) => g.p === path)).toBe(true);
    }
    expect(JSON.stringify(map)).not.toContain("secret prompt text");
    expect(JSON.stringify(map)).not.toContain("openai");
    expect(JSON.stringify(map)).not.toContain("missing");
  });

  // Regression: Codex review on #126 — running from a subfolder mapped only that subtree, with wrong paths
  // protects: one map per repo whatever folder the command runs in; fails_when: a subfolder run sends paths relative to it or omits root files; no_claim: worktrees
  it("maps the whole repo from its root when run in a subfolder", async () => {
    const { buildCodeMap } = await import("../code-map.js");
    expect(buildCodeMap(join(repo, "src/lib"))).toEqual(buildCodeMap(repo));
  });

  // Regression: Codex review on #126 — one file with too many exports made the server refuse the whole map
  // protects: a map the server accepts whatever a file exports; fails_when: 1,001 exports or a 201-character name reach the payload; no_claim: which 1,000 names are the most useful
  it("keeps each file within the server's limits on exported names", async () => {
    const { buildCodeMap } = await import("../code-map.js");
    const { parseCodeMap } = await import("../../src/lib/code-map.js");
    const many = Array.from({ length: 1001 }, (_, i) => `export const n${i} = ${i};`).join("\n");
    write(repo, { "src/lib/many.ts": `${many}\nexport const ${"a".repeat(201)} = 1;\n` });
    const map = buildCodeMap(repo)!;
    const many2 = map.files.find((f) => f.p === "src/lib/many.ts")!;
    expect(many2.e).toHaveLength(1000);
    expect(many2.e!.every((n) => n.length <= 200)).toBe(true);
    expect(parseCodeMap(map).ok).toBe(true);
  });

  // Regression: Codex review on #126 — git lengthens --short=7 when 7 characters are ambiguous, and the server takes exactly 7
  it("gives head7 as the first 7 characters of HEAD even when git would abbreviate it longer", async () => {
    const { buildCodeMap } = await import("../code-map.js");
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "first");
    abbrev.ambiguous = true;
    try {
      expect(buildCodeMap(repo)!.head7).toBe(git(repo, "rev-parse", "HEAD").slice(0, 7));
    } finally {
      abbrev.ambiguous = false;
    }
  });

  // Regression: Codex review on #126 — one path the server refuses made it reject the whole map
  // protects: a repo with an odd path still syncs; fails_when: a path over 512 characters or with a backslash is sent, or an import points at it; no_claim: other server checks
  it("leaves out paths the server would refuse, and imports of them", async () => {
    const { buildCodeMap } = await import("../code-map.js");
    const { parseCodeMap } = await import("../../src/lib/code-map.js");
    const long = `src/${"a".repeat(200)}/${"b".repeat(200)}/${"c".repeat(200)}.ts`;
    write(repo, {
      [long]: "export const deep = 1;\n",
      "src/odd\\name.ts": "export const odd = 1;\n",
      "src/uses.ts": `import { deep } from "./${"a".repeat(200)}/${"b".repeat(200)}/${"c".repeat(200)}";\nexport const uses = deep;\n`,
    });
    const map = buildCodeMap(repo)!;
    const paths = map.files.map((f) => f.p);
    expect(paths).toContain("src/uses.ts");
    expect(paths).not.toContain(long);
    expect(paths.some((p) => p.includes("\\"))).toBe(false);
    expect(map.files.find((f) => f.p === "src/uses.ts")!.i).toBeUndefined();
    expect(parseCodeMap(map).ok).toBe(true);
  });

  it("returns null when the repo has no origin remote", async () => {
    const { buildCodeMap } = await import("../code-map.js");
    const bare = makeRepo({ "a.ts": "export const a = 1;\n" }, null);
    try {
      expect(buildCodeMap(bare)).toBeNull();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  // protects: hook syncs stay fast on large repos; fails_when: unchanged files are read again, or a changed one is not; no_claim: speed on any particular repo
  it("reads only files whose content changed since the last build", async () => {
    const { buildCodeMap, readBlobBatches } = await import("../code-map.js");
    const cache = {};
    let reads = 0;
    const counting = (cwd: string, ids: string[]) => { reads += ids.length; return readBlobBatches(cwd, ids); };

    buildCodeMap(repo, { cache, readBlobs: counting });
    expect(reads).toBeGreaterThan(0);

    reads = 0;
    const again = buildCodeMap(repo, { cache, readBlobs: counting });
    expect(reads).toBe(0);
    expect(again!.files.find((f) => f.p === "src/lib/llm.ts")).toEqual({ p: "src/lib/llm.ts", e: ["callModel"], i: ["src/lib/text.ts", "src/lib/db.ts"] });

    write(repo, { "src/lib/text.ts": "export const segment = () => 1;\nexport function tokens() {}\n" });
    reads = 0;
    const changed = buildCodeMap(repo, { cache, readBlobs: counting });
    expect(reads).toBe(1);
    expect(changed!.files.find((f) => f.p === "src/lib/text.ts")).toEqual({ p: "src/lib/text.ts", e: ["segment", "tokens"] });
  });
  // protects: a first sync of a large repo holds one batch of files in memory at a time; fails_when: names from a later batch are lost, or a file's names come from another file; no_claim: peak memory itself
  it("builds the same map when files arrive in many small batches", async () => {
    const { buildCodeMap, readBlobBatches } = await import("../code-map.js");
    const oneAtATime = function* (cwd: string, ids: string[]) {
      for (const id of ids) yield* readBlobBatches(cwd, [id]);
    };
    expect(buildCodeMap(repo, { readBlobs: oneAtATime })).toEqual(buildCodeMap(repo));
  });

  // protects: a hook sync stays quick on files that are mostly comments, which are blanked to spaces before matching; fails_when: a line-start pattern rescans the rest of the file from every line (seconds per file); no_claim: speed on any particular machine
  it.each([
    ["js", "notes.ts", "// ", "import './side';\nexport const kept = 1;\n"],
    ["py", "notes.py", "# ", "from .side import thing\ndef kept():\n    pass\n"],
    ["rs", "notes.rs", "// ", "pub fn kept() {}\n"],
  ])("maps a %s file that is mostly comments in well under a second", async (_lang, path, comment, code) => {
    const { buildCodeMap } = await import("../code-map.js");
    write(repo, { [path]: code + (comment + "x".repeat(95) + "\n").repeat(9000) });
    const started = Date.now();
    const map = buildCodeMap(repo, { cache: {} });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(map!.files.find((f) => f.p === path)!.e).toEqual(["kept"]);
  });

  // protects: an upgrade fixes names cached by an older version; fails_when: a name cached before comments were skipped is sent again; no_claim: caches from other tools
  it("rebuilds names cached by an older version", async () => {
    const { buildCodeMap } = await import("../code-map.js");
    const blob = git(repo, "rev-parse", ":src/lib/text.ts");
    const cache = { repos: { "acme/widgets": { blobs: { [`${blob}:js`]: { e: ["fromAComment"] } } } } };
    expect(buildCodeMap(repo, { cache })!.files.find((f) => f.p === "src/lib/text.ts")).toEqual({ p: "src/lib/text.ts", e: ["segment"] });
  });
});

describe("readBlobBatches", () => {
  // protects: a cold sync of a repo with many large files can't overflow one read; fails_when: all blobs are read in one pass, or a batch goes over the budget; no_claim: the default budget's value
  it("reads blobs in batches that each fit the byte budget", async () => {
    const { readBlobBatches } = await import("../code-map.js");
    const body = (c: string) => c.repeat(400 * 1024);
    const dir = makeRepo({ "a.ts": body("a"), "b.ts": body("b"), "c.ts": body("c"), "big.ts": "x".repeat(1024 * 1024 + 1) });
    try {
      const ids = ["a.ts", "b.ts", "c.ts", "big.ts"].map((p) => git(dir, "rev-parse", `:${p}`));
      const batches = [...readBlobBatches(dir, ids, 1024 * 1024)];
      expect(batches.length).toBeGreaterThan(1);
      for (const b of batches) expect([...b.values()].reduce((n, s) => n + s.length, 0)).toBeLessThanOrEqual(1024 * 1024);
      const all = new Map(batches.flatMap((b) => [...b]));
      expect(all).toEqual(new Map([[ids[0], body("a")], [ids[1], body("b")], [ids[2], body("c")], [ids[3], ""]]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("capMap", () => {
  // protects: the 3,000-file and 120 KB caps; fails_when: detail is dropped in the wrong order, a capped map exceeds a limit, or deep files are kept over shallow ones; no_claim: which files matter most
  const path = (n: number, depth = 2) => `${Array.from({ length: depth - 1 }, (_, d) => `dir${d}`).join("/")}/file-${String(n).padStart(4, "0")}.ts`;

  it("leaves a small map as it is", async () => {
    const { capMap } = await import("../code-map.js");
    const files = [{ p: "a.ts", e: ["a"], i: ["b.ts"] }, { p: "b.ts" }];
    expect(capMap(files)).toEqual({ files, truncated: false });
  });

  it("drops imports first when the map is over 120 KB", async () => {
    const { capMap } = await import("../code-map.js");
    const files = Array.from({ length: 1000 }, (_, n) => ({
      p: path(n),
      e: ["exportedName"],
      i: Array.from({ length: 6 }, (_, k) => path((n + k + 1) % 1000)),
    }));
    const capped = capMap(files);
    expect(capped.truncated).toBe(false);
    expect(capped.files).toHaveLength(1000);
    expect(capped.files.every((f) => f.i === undefined && f.e?.[0] === "exportedName")).toBe(true);
    expect(JSON.stringify(capped.files).length).toBeLessThanOrEqual(120 * 1024);
  });

  it("then drops exports, keeping every path", async () => {
    const { capMap } = await import("../code-map.js");
    const files = Array.from({ length: 1000 }, (_, n) => ({
      p: path(n),
      e: Array.from({ length: 12 }, (_, k) => `someLongExportedName${k}`),
    }));
    const capped = capMap(files);
    expect(capped.truncated).toBe(false);
    expect(capped.files).toEqual(files.map((f) => ({ p: f.p })));
  });

  it("keeps the 3,000 shallowest paths and says the map is truncated", async () => {
    const { capMap } = await import("../code-map.js");
    const deep = Array.from({ length: 600 }, (_, n) => ({ p: path(n, 6) }));
    const shallow = Array.from({ length: 2900 }, (_, n) => ({ p: path(n, 2) }));
    const capped = capMap([...deep, ...shallow]);
    expect(capped.truncated).toBe(true);
    expect(capped.files).toHaveLength(3000);
    expect(shallow.every((f) => capped.files.some((g) => g.p === f.p))).toBe(true);
    expect(capped.files.filter((f) => f.p.startsWith("dir0/dir1/"))).toHaveLength(100);
  });
});

describe("syncCodeMap", () => {
  let repo: string;
  let home: string;
  let cachePath: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    repo = makeRepo(FIXTURE);
    home = mkdtempSync(join(tmpdir(), "xkg-code-map-home-"));
    cachePath = join(home, ".xkg", "maps.json");
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true, files: 8, truncated: false }), { status: 200 })));
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  function posted(): Array<{ url: string; auth: string; body: { repo: string; files: unknown[] } }> {
    return fetchSpy.mock.calls.map((c: unknown[]) => {
      const init = c[1] as { body: string; headers: Record<string, string> };
      return { url: String(c[0]), auth: init.headers["Authorization"]!, body: JSON.parse(init.body) as { repo: string; files: unknown[] } };
    });
  }

  // protects: the map reaches xkg once per change; fails_when: an unchanged map is sent again, a changed one is not, or the key goes elsewhere; no_claim: what the server does with it
  it("sends the map with the API key, then only when it changed", async () => {
    const { syncCodeMap } = await import("../code-map.js");
    expect(await syncCodeMap("key-1", repo, { cachePath })).toEqual({ status: "synced", repo: "acme/widgets", files: 8 });
    expect(posted()).toHaveLength(1);
    expect(posted()[0]).toMatchObject({ url: "https://xkg.xmu.sh/api/code-map", auth: "Bearer key-1", body: { repo: "acme/widgets" } });
    expect(posted()[0]!.body.files).toHaveLength(8);

    expect(await syncCodeMap("key-1", repo, { cachePath })).toEqual({ status: "unchanged", repo: "acme/widgets", files: 8 });
    expect(posted()).toHaveLength(1);

    write(repo, { "src/lib/new.ts": "export function fresh() {}\n" });
    expect(await syncCodeMap("key-1", repo, { cachePath })).toMatchObject({ status: "synced", files: 9 });
    expect(posted()).toHaveLength(2);
  });

  // Regression: Codex review on #126 — after switching to another account's key, the unchanged gate sent that account nothing
  // protects: each account gets the map once; fails_when: a new key reports unchanged without sending; no_claim: how the key is stored
  it("sends the map again when the API key changes", async () => {
    const { syncCodeMap } = await import("../code-map.js");
    await syncCodeMap("key-1", repo, { cachePath });
    expect(await syncCodeMap("key-2", repo, { cachePath })).toMatchObject({ status: "synced" });
    expect(posted().map((p) => p.auth)).toEqual(["Bearer key-1", "Bearer key-2"]);
    expect(readFileSync(cachePath, "utf8")).not.toContain("key-2");
  });

  // Regression: Codex review on #126 — an unchanged map was never sent again, so the server's copy aged out or was dropped for good
  // protects: the server's map stays current while the repo is in use; fails_when: an unchanged map is not re-sent after a day; no_claim: the exact interval
  it("sends an unchanged map again once a day", async () => {
    const { syncCodeMap } = await import("../code-map.js");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-29T10:00:00Z"));
      await syncCodeMap("key-1", repo, { cachePath });
      vi.setSystemTime(new Date("2026-10-30T09:00:00Z"));
      expect(await syncCodeMap("key-1", repo, { cachePath })).toMatchObject({ status: "unchanged" });
      vi.setSystemTime(new Date("2026-10-30T10:00:01Z"));
      expect(await syncCodeMap("key-1", repo, { cachePath })).toMatchObject({ status: "synced" });
      expect(posted()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("syncs an unchanged map when forced", async () => {
    const { syncCodeMap } = await import("../code-map.js");
    await syncCodeMap("key-1", repo, { cachePath });
    expect(await syncCodeMap("key-1", repo, { cachePath, force: true })).toMatchObject({ status: "synced" });
    expect(posted()).toHaveLength(2);
  });

  it("tries again next time when the server refused the map", async () => {
    const { syncCodeMap } = await import("../code-map.js");
    fetchSpy.mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({ ok: false, error: "nope" }), { status: 500 })));
    expect(await syncCodeMap("key-1", repo, { cachePath })).toEqual({ status: "failed", repo: "acme/widgets", reason: "xkg answered HTTP 500." });
    expect(await syncCodeMap("key-1", repo, { cachePath })).toMatchObject({ status: "synced" });
    expect(posted()).toHaveLength(2);
  });

  it("gives up after the timeout when xkg can't be reached, without throwing", async () => {
    const { syncCodeMap } = await import("../code-map.js");
    fetchSpy.mockImplementation((_url: unknown, init: unknown) => new Promise((_, reject) => {
      (init as { signal: AbortSignal }).signal.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const started = Date.now();
    const result = await syncCodeMap("key-1", repo, { cachePath, timeoutMs: 50 });
    expect(result).toMatchObject({ status: "failed" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("sends nothing for a repo without an origin remote, and says why", async () => {
    const { syncCodeMap } = await import("../code-map.js");
    const bare = makeRepo({ "a.ts": "export const a = 1;\n" }, null);
    try {
      expect(await syncCodeMap("key-1", bare, { cachePath })).toEqual({ status: "skipped", reason: "This repo has no origin remote, so xkg can't tell which repo it is." });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  // Regression: ISSUE-001 — outside a git repo, `xkg map` blamed a missing origin remote
  // Found by /qa on 2026-10-29
  it("says when the folder is not a git repo at all, without contacting xkg", async () => {
    const { syncCodeMap } = await import("../code-map.js");
    const plain = mkdtempSync(join(tmpdir(), "xkg-not-a-repo-"));
    try {
      expect(await syncCodeMap("key-1", plain, { cachePath })).toEqual({ status: "skipped", reason: "Not a git repository. Run this inside the repo you code in." });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("keeps the cache next to the CLI config, never in the repo", async () => {
    const { syncCodeMap } = await import("../code-map.js");
    await syncCodeMap("key-1", repo, { cachePath });
    const cache = JSON.parse(readFileSync(cachePath, "utf-8")) as { repos: Record<string, { hash: string }> };
    expect(Object.keys(cache.repos)).toEqual(["acme/widgets"]);
    expect(git(repo, "status", "--porcelain", "--untracked-files=all").split("\n").filter((l) => l.startsWith("??"))).toEqual([]);
  });
});

describe("agent-agnostic", () => {
  // protects: the map works the same for every agent; fails_when: a map code path reads or writes one agent's config; no_claim: runtime behavior (the hook tests cover plain git)
  it("touches no agent's config files", () => {
    const sources = ["cli/code-map.ts", "src/lib/code-map.ts", "src/app/api/code-map/route.ts"]
      .map((f) => readFileSync(join(process.cwd(), f), "utf-8"));
    for (const src of sources) {
      expect(src).not.toMatch(/\.claude|\.codex|\.cursor|\.gemini|CLAUDE\.md|AGENTS\.md|GEMINI\.md/);
    }
  });
});
