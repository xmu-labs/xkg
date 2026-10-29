import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { execFileSync } from "child_process";
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
    const { buildCodeMap, readBlobs } = await import("../code-map.js");
    const cache = {};
    let reads = 0;
    const counting = (cwd: string, ids: string[]) => { reads += ids.length; return readBlobs(cwd, ids); };

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
