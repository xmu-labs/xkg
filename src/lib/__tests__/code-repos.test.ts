import { describe, it, expect, vi } from "vitest";
import { fetchGithubMap, GITHUB_MAP_MAX_AGE_DAYS, refreshStaleGithubMaps, repoName } from "../code-repos";
import type { StoredCodeMap } from "../code-map";

/** Adding a repo from GitHub: file paths only, read with the user's own GitHub sign-in. */

type Entry = { path: string; type: "blob" | "tree" | "commit"; mode?: string };

function tree(entries: Entry[], truncated = false) {
  return { sha: "f".repeat(40), truncated, tree: entries.map((e) => ({ mode: e.mode ?? "100644", sha: "a".repeat(40), size: 10, url: "u", ...e })) };
}

function github(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  });
  return { calls, fetchImpl };
}

describe("fetchGithubMap", () => {
  // protects: AC1, a GitHub repo is stored as paths only, read with the user's sign-in; fails_when: exports or contents are stored, another URL or no token is used, folders or submodules become files; no_claim: GitHub's own API behavior
  it("keeps only file paths from the default branch's tree", async () => {
    const { calls, fetchImpl } = github(200, tree([
      { path: "src", type: "tree" },
      { path: "src/lib/db.ts", type: "blob" },
      { path: "README.md", type: "blob" },
      { path: "vendored-lib", type: "commit", mode: "160000" },
    ]));
    const res = await fetchGithubMap("gho_token", "acme/widgets", fetchImpl);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.github.com/repos/acme/widgets/git/trees/HEAD?recursive=1");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer gho_token");
    expect(res).toEqual({ ok: true, map: { repo: "acme/widgets", head7: "", truncated: false, files: [{ p: "src/lib/db.ts" }, { p: "README.md" }] } });
  });

  // protects: the same files are left out as in a local map; fails_when: dependencies, build output, tests, lockfiles or images are stored; no_claim: which files matter for matching
  it("leaves out the same files the local map leaves out", async () => {
    const { fetchImpl } = github(200, tree([
      { path: "node_modules/x/index.js", type: "blob" },
      { path: "dist/app.js", type: "blob" },
      { path: "src/__tests__/db.test.ts", type: "blob" },
      { path: "src/db.spec.ts", type: "blob" },
      { path: "package-lock.json", type: "blob" },
      { path: "public/logo.png", type: "blob" },
      { path: "src/db.ts", type: "blob" },
    ]));
    const res = await fetchGithubMap("t", "acme/widgets", fetchImpl);
    expect(res.ok && res.map.files).toEqual([{ p: "src/db.ts" }]);
  });

  // protects: the server's map limits hold for a GitHub map; fails_when: a path the server refuses fails the whole map, or a long one is stored; no_claim: GitHub path rules
  it("drops paths the server would refuse", async () => {
    const { fetchImpl } = github(200, tree([
      { path: `src/${"a".repeat(600)}.ts`, type: "blob" },
      { path: "src/odd\\name.ts", type: "blob" },
      { path: "src/ok.ts", type: "blob" },
    ]));
    const res = await fetchGithubMap("t", "acme/widgets", fetchImpl);
    expect(res.ok && res.map.files).toEqual([{ p: "src/ok.ts" }]);
  });

  // protects: the 3000-file cap keeps the shallowest paths and says so; fails_when: a huge repo is refused, kept whole, or cut at random; no_claim: which files a truncated map should keep
  it("caps a large repo like the CLI does and marks it truncated", async () => {
    const entries: Entry[] = Array.from({ length: 3001 }, (_, n) => ({ path: n === 0 ? "deep/a/b/c/d.ts" : `src/f${n}.ts`, type: "blob" }));
    const { fetchImpl } = github(200, tree(entries));
    const res = await fetchGithubMap("t", "acme/widgets", fetchImpl);
    expect(res.ok && res.map.truncated).toBe(true);
    expect(res.ok && res.map.files).toHaveLength(3000);
    expect(res.ok && res.map.files.some((f) => f.p === "deep/a/b/c/d.ts")).toBe(false);
  });

  // protects: a tree GitHub cut short is marked truncated; fails_when: a partial listing looks complete; no_claim: what GitHub leaves out
  it("marks the map truncated when GitHub's listing was cut short", async () => {
    const { fetchImpl } = github(200, tree([{ path: "a.ts", type: "blob" }], true));
    const res = await fetchGithubMap("t", "acme/widgets", fetchImpl);
    expect(res.ok && res.map.truncated).toBe(true);
  });

  // protects: AC2, a repo the sign-in can't read gives a clear error; fails_when: the error is GitHub's raw text or an empty map is stored; no_claim: why GitHub refused
  it.each([401, 403, 404])("says the sign-in can't read the repo on HTTP %i", async (status) => {
    const { fetchImpl } = github(status, { message: "Not Found" });
    expect(await fetchGithubMap("t", "acme/widgets", fetchImpl)).toEqual({ ok: false, error: "xkg can't read acme/widgets with your GitHub sign-in. Check the name, and that your account can open it." });
  });

  // protects: an empty repo is refused, not stored as an empty map; fails_when: GitHub's 409 for an empty repo is stored; no_claim: other 4xx answers
  it("refuses an empty repo", async () => {
    const { fetchImpl } = github(409, { message: "Git Repository is empty." });
    expect(await fetchGithubMap("t", "acme/widgets", fetchImpl)).toEqual({ ok: false, error: "acme/widgets has no files yet." });
  });

  // protects: a GitHub outage or timeout fails cleanly; fails_when: the error leaks the token or throws; no_claim: retry policy
  it("fails cleanly when GitHub doesn't answer", async () => {
    const down = vi.fn(async () => { throw new Error("connect ECONNREFUSED"); });
    expect(await fetchGithubMap("t", "acme/widgets", down)).toEqual({ ok: false, error: "GitHub didn't answer. Try again in a minute." });
    const { fetchImpl } = github(502, {});
    expect(await fetchGithubMap("t", "acme/widgets", fetchImpl)).toEqual({ ok: false, error: "GitHub didn't answer. Try again in a minute." });
  });

  // protects: the repo name can't steer the request elsewhere; fails_when: a path-like name reaches the URL with the user's token; no_claim: GitHub's naming rules
  it("refuses a name that isn't owner/name without calling GitHub", async () => {
    const { fetchImpl } = github(200, tree([]));
    for (const repo of ["acme", "acme/widgets/../../user", "../x/y", "acme/..", "./x", "acme/wid gets", ""]) {
      expect(await fetchGithubMap("t", repo, fetchImpl)).toEqual({ ok: false, error: "Enter the repo as owner/name, for example acme/widgets." });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // protects: a pasted GitHub URL works; fails_when: the user has to strip the URL by hand; no_claim: other hosts
  it("accepts a pasted github.com URL", async () => {
    const { calls, fetchImpl } = github(200, tree([{ path: "a.ts", type: "blob" }]));
    const res = await fetchGithubMap("t", " https://github.com/acme/widgets.git ", fetchImpl);
    expect(res.ok && res.map.repo).toBe("acme/widgets");
    expect(calls[0]!.url).toBe("https://api.github.com/repos/acme/widgets/git/trees/HEAD?recursive=1");
  });

  // protects: a repo typed in another case is the same repo as the local map; fails_when: Acme/Widgets is stored beside acme/widgets; no_claim: hosts other than GitHub
  it("names the repo in lowercase, as GitHub matches it", async () => {
    const { calls, fetchImpl } = github(200, tree([{ path: "a.ts", type: "blob" }]));
    const res = await fetchGithubMap("t", "https://github.com/Acme/Widgets", fetchImpl);
    expect(res.ok && res.map.repo).toBe("acme/widgets");
    expect(calls[0]!.url).toBe("https://api.github.com/repos/acme/widgets/git/trees/HEAD?recursive=1");
  });
});

describe("refreshStaleGithubMaps", () => {
  const now = new Date("2026-10-29T12:00:00Z");
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
  const stored = (repo: string, source: "local" | "github", age: number): StoredCodeMap =>
    ({ repo, files: [{ p: "old.ts" }], head7: null, truncated: false, source, syncedAt: daysAgo(age) });

  // protects: AC5, a GitHub map older than 7 days is refetched once and used; fails_when: it isn't refreshed, a local or fresh map is refetched, or the new map isn't stored; no_claim: GitHub's answer
  it("refetches only GitHub maps older than 7 days and stores them", async () => {
    expect(GITHUB_MAP_MAX_AGE_DAYS).toBe(7);
    const { calls, fetchImpl } = github(200, tree([{ path: "new.ts", type: "blob" }]));
    const update = vi.fn(async () => true);
    const maps = [stored("acme/old", "github", 8), stored("acme/fresh", "github", 6), stored("acme/local", "local", 30)];
    const out = await refreshStaleGithubMaps("t", 7, maps, { fetchImpl, update, now: () => now });
    expect(calls.map((c) => c.url)).toEqual(["https://api.github.com/repos/acme/old/git/trees/HEAD?recursive=1"]);
    expect(update).toHaveBeenCalledWith(7, { repo: "acme/old", head7: "", truncated: false, files: [{ p: "new.ts" }] }, expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(out.map((m) => [m.repo, m.files[0]!.p])).toEqual([["acme/old", "new.ts"], ["acme/fresh", "old.ts"], ["acme/local", "old.ts"]]);
    expect(out[0]!.syncedAt).toEqual(now);
  });

  // protects: AC5, a failed refresh keeps the old map; fails_when: a GitHub error drops the repo, throws, or stores nothing-for-something; no_claim: when to retry
  it("keeps the old map when the refresh fails", async () => {
    const update = vi.fn(async () => true);
    const maps = [stored("acme/old", "github", 9)];
    for (const fetchImpl of [github(404, {}).fetchImpl, vi.fn(async () => { throw new Error("down"); })]) {
      expect(await refreshStaleGithubMaps("t", 7, maps, { fetchImpl, update, now: () => now })).toEqual(maps);
    }
    expect(update).not.toHaveBeenCalled();
    const failingUpdate = vi.fn(async () => { throw new Error("db down"); });
    expect(await refreshStaleGithubMaps("t", 7, maps, { fetchImpl: github(200, tree([{ path: "n.ts", type: "blob" }])).fetchImpl, update: failingUpdate, now: () => now })).toEqual(maps);
  });

  // protects: precedence and removal, a local sync or a removal that landed meanwhile is not undone; fails_when: the refetched GitHub files are used though the row is now local or gone; no_claim: the race window itself
  it("keeps the old map in hand when the row was not updated", async () => {
    const maps = [stored("acme/old", "github", 9)];
    const update = vi.fn(async () => false);
    expect(await refreshStaleGithubMaps("t", 7, maps, { fetchImpl: github(200, tree([{ path: "n.ts", type: "blob" }])).fetchImpl, update, now: () => now })).toEqual(maps);
  });

  // protects: no GitHub call without a token; fails_when: a request goes out without the user's sign-in; no_claim: token validity
  it("does nothing without a token", async () => {
    const { fetchImpl } = github(200, tree([]));
    const maps = [stored("acme/old", "github", 9)];
    expect(await refreshStaleGithubMaps(null, 7, maps, { fetchImpl, now: () => now })).toBe(maps);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("repoName", () => {
  // protects: what a user types or pastes becomes owner/name; fails_when: a URL, .git or trailing slashes aren't stripped; no_claim: none
  it("reads owner/name from what the user typed", () => {
    expect(repoName(" https://github.com/Acme/App.git ")).toBe("acme/app");
    expect(repoName("acme/app///")).toBe("acme/app");
    expect(repoName("acme")).toBeNull();
    expect(repoName("acme/app/extra")).toBeNull();
  });

  // protects: a request body can't make the name check slow; fails_when: a long run of slashes takes more than a moment; no_claim: none
  it("stays fast on a long run of slashes", () => {
    const started = performance.now();
    expect(repoName(`a${"/".repeat(200_000)}b`)).toBeNull();
    expect(repoName(`acme/app${"/".repeat(200_000)}`)).toBe("acme/app");
    expect(performance.now() - started).toBeLessThan(200);
  });
});
