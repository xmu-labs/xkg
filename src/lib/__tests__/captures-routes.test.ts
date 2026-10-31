import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * The web app's captures page: list, archive, delete, check links, rules per
 * tag and weekly applies. These were MCP tools; they are human decisions, so
 * they live where the human is. Captures stay in the user's knowledge repo,
 * which these routes read and write through the GitHub contents API.
 */

const user = { id: 7, github_token: "gho_user", github_repo: "o/knowledge", llm_api_key: "sk-user", llm_provider: "openai", llm_model: "gpt-6.1-terra" };
let session: Record<string, unknown> | null = user;
const files = new Map<string, { content: string; sha: string }>();
const githubPut = vi.fn(async (_t: string, _r: string, path: string, content: string) => {
  files.set(path, { content, sha: "s" });
  return true;
});
const githubDelete = vi.fn(async (_t: string, _r: string, path: string) => {
  files.delete(path);
  return true;
});
const updateIndexEntry = vi.fn();
const forgetCapture = vi.fn();
const consumeQuota = vi.fn();
const safeFetch = vi.fn();
const synthesizeTopic = vi.fn();

vi.mock("@/lib/session", () => ({ getSession: async () => session }));
vi.mock("@/lib/rate-limit", () => ({ consumeQuota: (...a: unknown[]) => consumeQuota(...a) }));
vi.mock("@/lib/handoff-learning", () => ({ forgetCapture: (...a: unknown[]) => forgetCapture(...a) }));
vi.mock("@/lib/fetch-source", () => ({ safeFetch: (...a: unknown[]) => safeFetch(...a) }));
vi.mock("@/lib/synthesis", () => ({ synthesizeTopic: (...a: unknown[]) => synthesizeTopic(...a) }));
/** Paths GitHub answers with a 503, as for a rate limit, revoked token or outage. */
const down = new Set<string>();
vi.mock("@/lib/github", async () => {
  const { GitHubReadError } = await vi.importActual<typeof import("@/lib/github")>("@/lib/github");
  return {
  GitHubReadError,
  readFile: async (_t: string, _r: string, path: string) => (down.has(path) ? null : files.get(path) ?? null),
  readFileStrict: async (_t: string, _r: string, path: string) => {
    if (down.has(path)) throw new GitHubReadError(path, 503);
    return files.get(path) ?? null;
  },
  githubGet: async (_t: string, _r: string, dir: string) => {
    if (down.has(dir)) return { ok: false, data: null, status: 503 };
    const names = [...files.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => ({ name: p.slice(dir.length + 1) }));
    return names.length ? { ok: true, data: names, status: 200 } : { ok: false, data: null, status: 404 };
  },
  githubPut: (...a: Parameters<typeof githubPut>) => githubPut(...a),
  githubDelete: (...a: Parameters<typeof githubDelete>) => githubDelete(...a),
  updateIndexEntry: (...a: unknown[]) => updateIndexEntry(...a),
  };
});

const list = await import("@/app/api/captures/route");
const archive = await import("@/app/api/captures/archive/route");
const del = await import("@/app/api/captures/delete/route");
const check = await import("@/app/api/captures/check/route");
const rules = await import("@/app/api/rules/route");
const stats = await import("@/app/api/apply-stats/route");

const INDEX = `| Date | Capture | Summary | Tags | Type |
|------|---------|---------|------|------|
| 2026-10-28 | [llm-memory](inbox/2026-10-28-llm-memory.md) | Memory goes into the prompt.... | llm | article |
| 2026-10-20 | [old-post](archived/2026-10-20-old-post.md) | An old post.... | blog | post |
`;
const CAPTURE = "2026-10-28-llm-memory.md";
const captureFile = (url = "https://example.com/post", low = false) =>
  `---\nsource: Example\nurl: ${url}\nstatus: inbox\n${low ? "lowConfidence: true\n" : ""}---\n\n# LLM memory\n`;

function req(path: string, body?: unknown): NextRequest {
  return new NextRequest(`https://xkg.test${path}`, body === undefined ? {} : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  session = user;
  down.clear();
  files.clear();
  files.set("INDEX.md", { content: INDEX, sha: "i" });
  files.set(`inbox/${CAPTURE}`, { content: captureFile(), sha: "c" });
  githubPut.mockClear();
  githubDelete.mockClear();
  updateIndexEntry.mockReset();
  forgetCapture.mockReset();
  safeFetch.mockReset().mockResolvedValue({ status: 200 });
  synthesizeTopic.mockReset();
  consumeQuota.mockReset().mockResolvedValue({ allowed: true, limit: 30, resetIn: 3600 });
});

describe("every captures route", () => {
  // protects: only the signed-in user reaches their repo; fails_when: a route answers without a session; no_claim: session cookies (session tests)
  it("answers 401 without a session", async () => {
    session = null;
    const answers = await Promise.all([
      list.GET(req("/api/captures")),
      archive.POST(req("/api/captures/archive", { filename: CAPTURE })),
      del.POST(req("/api/captures/delete", { filename: CAPTURE })),
      check.POST(req("/api/captures/check", {})),
      rules.POST(req("/api/rules", { tag: "llm" })),
      stats.GET(req("/api/apply-stats")),
    ]);
    expect(answers.map((r) => r.status)).toEqual([401, 401, 401, 401, 401, 401]);
  });
});

describe("GET /api/captures", () => {
  // protects: the list reads INDEX.md and filters by folder; fails_when: archived rows show under inbox; no_claim: row parsing (captures tests)
  it("lists the captures in a folder", async () => {
    const res = await list.GET(req("/api/captures?status=inbox"));
    expect(res.status).toBe(200);
    const body = await res.json() as { captures: Array<{ filename: string }> };
    expect(body.captures.map((c) => c.filename)).toEqual([CAPTURE]);
  });

  // protects: a new user with no index sees an empty list, not an error; fails_when: a missing INDEX.md is a 404 or 500; no_claim: onboarding
  it("returns an empty list when the repo has no index yet", async () => {
    files.delete("INDEX.md");
    const res = await list.GET(req("/api/captures"));
    expect(await res.json()).toEqual({ captures: [] });
  });
});

describe("POST /api/captures/archive", () => {
  // protects: archive moves the file to archived/ and updates the index, as the MCP tool did; fails_when: the file stays in inbox or the index isn't updated; no_claim: index rewriting (github tests)
  it("moves an inbox capture to archived/", async () => {
    const res = await archive.POST(req("/api/captures/archive", { filename: CAPTURE }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(files.has(`inbox/${CAPTURE}`)).toBe(false);
    expect(files.get(`archived/${CAPTURE}`)?.content).toContain("status: archived");
    expect(updateIndexEntry).toHaveBeenCalledWith("gho_user", "o/knowledge", CAPTURE, "archive");
  });

  // protects: the route only touches a capture by its bare name; fails_when: a path like ../INDEX.md is read or moved; no_claim: name rules (captures tests)
  it("rejects a name that isn't a bare capture filename", async () => {
    const res = await archive.POST(req("/api/captures/archive", { filename: "../INDEX.md" }));
    expect(res.status).toBe(400);
    expect(githubPut).not.toHaveBeenCalled();
  });

  // protects: archiving twice (two tabs) says so instead of claiming success; fails_when: a missing file answers ok; no_claim: GitHub errors
  it("answers 404 when the capture isn't in the inbox", async () => {
    const res = await archive.POST(req("/api/captures/archive", { filename: "2026-01-01-gone.md" }));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/captures/delete", () => {
  // protects: delete removes the file, its index row and what handoffs learned about it, as the MCP tool did; fails_when: any of the three is left; no_claim: handoff learning itself
  it("deletes an inbox capture, its index row and its handoff history", async () => {
    const res = await del.POST(req("/api/captures/delete", { filename: CAPTURE }));
    expect(res.status).toBe(200);
    expect(files.has(`inbox/${CAPTURE}`)).toBe(false);
    expect(updateIndexEntry).toHaveBeenCalledWith("gho_user", "o/knowledge", CAPTURE, "delete");
    expect(forgetCapture).toHaveBeenCalledWith(7, CAPTURE);
  });

  // protects: body validation; fails_when: invalid JSON throws a 500; no_claim: other routes' guards
  it("answers 400 to a body that isn't JSON", async () => {
    const res = await del.POST(req("/api/captures/delete", "not json"));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/captures/check", () => {
  // protects: check links flags a gone source and a low-confidence capture, and archives nothing by itself; fails_when: a 404 source reads ok, or a file moves; no_claim: SSRF guarding (fetch-source tests)
  it("flags gone sources and low-confidence captures without archiving them", async () => {
    files.set("inbox/2026-10-29-weak.md", { content: captureFile("none", true), sha: "w" });
    safeFetch.mockResolvedValue({ status: 404 });
    const res = await check.POST(req("/api/captures/check", {}));
    expect(res.status).toBe(200);
    const body = await res.json() as { results: Array<{ filename: string; status: string }>; total: number; next: number | null };
    expect(body.results.map((r) => [r.filename, r.status])).toEqual([
      [CAPTURE, "stale"],
      ["2026-10-29-weak.md", "low_confidence"],
    ]);
    expect(body).toMatchObject({ total: 2, next: null });
    expect(githubPut).not.toHaveBeenCalled();
  });

  // protects: paging by `after` starts right after that filename and says which filename comes next, so a capture archived between pages never shifts the next page; fails_when: `after` is ignored, or `last` is set on the final page; no_claim: the HEAD requests themselves
  it("pages by the last checked filename and names the next starting point", async () => {
    for (const n of ["a", "b", "c"]) files.set(`inbox/2026-10-30-${n}.md`, { content: captureFile("none", false), sha: n });
    safeFetch.mockResolvedValue({ status: 200 });
    const first = await (await check.POST(req("/api/captures/check", {}))).json() as { results: Array<{ filename: string }>; last: string | null };
    expect(first.results.map((r) => r.filename)).toEqual([CAPTURE, "2026-10-30-a.md", "2026-10-30-b.md", "2026-10-30-c.md"]);
    expect(first.last).toBeNull();
    const after = await (await check.POST(req("/api/captures/check", { after: "2026-10-30-a.md" }))).json() as { results: Array<{ filename: string }>; last: string | null };
    expect(after.results.map((r) => r.filename)).toEqual(["2026-10-30-b.md", "2026-10-30-c.md"]);
    expect(after.last).toBeNull();
    for (let i = 0; i < 20; i++) files.set(`inbox/2026-11-${String(i + 1).padStart(2, "0")}-x.md`, { content: captureFile("none", false), sha: `x${i}` });
    const full = await (await check.POST(req("/api/captures/check", {}))).json() as { results: Array<{ filename: string }>; last: string | null };
    expect(full.results).toHaveLength(20);
    expect(full.last).toBe("2026-11-16-x.md");
  });

  // protects: link checks make outbound requests, so they're rate limited; fails_when: a check runs past the quota; no_claim: the quota store
  it("answers 429 when the hourly quota is used up", async () => {
    consumeQuota.mockResolvedValue({ allowed: false, limit: 30, resetIn: 60 });
    const res = await check.POST(req("/api/captures/check", {}));
    expect(res.status).toBe(429);
    expect(safeFetch).not.toHaveBeenCalled();
  });
});

describe("POST /api/rules", () => {
  // protects: rules run on the user's own model and key, as every LLM call does; fails_when: another key or provider is used; no_claim: the synthesis prompt
  it("writes rules for a tag with the user's own model", async () => {
    synthesizeTopic.mockResolvedValue({ topic: "llm", rules: ["Keep memory small."] });
    const res = await rules.POST(req("/api/rules", { tag: "llm" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ topic: "llm", rules: ["Keep memory small."] });
    const [key, token, repo, tag, index, llm] = synthesizeTopic.mock.calls[0] as unknown[];
    expect([key, token, repo, tag, index]).toEqual(["sk-user", "gho_user", "o/knowledge", "llm", INDEX]);
    expect(llm).toMatchObject({ provider: "openai", model: "gpt-6.1-terra" });
  });

  // protects: an empty tag never reaches the model; fails_when: a blank tag calls the LLM; no_claim: tag spelling
  it("answers 400 without a tag", async () => {
    const res = await rules.POST(req("/api/rules", { tag: "  " }));
    expect(res.status).toBe(400);
    expect(synthesizeTopic).not.toHaveBeenCalled();
  });

  // protects: synthesis spends the user's tokens, so it's rate limited; fails_when: it runs past the quota; no_claim: the quota store
  it("answers 429 when the hourly quota is used up", async () => {
    consumeQuota.mockResolvedValue({ allowed: false, limit: 30, resetIn: 60 });
    const res = await rules.POST(req("/api/rules", { tag: "llm" }));
    expect(res.status).toBe(429);
    expect(synthesizeTopic).not.toHaveBeenCalled();
  });
});

describe("GET /api/apply-stats", () => {
  // protects: weekly applies come from APPLIED.md, the ledger apply_capture writes; fails_when: the counts or the weeks param are ignored; no_claim: week math (ledger tests)
  it("counts applies per week from the ledger", async () => {
    const today = new Date().toISOString().slice(0, 10);
    files.set("APPLIED.md", { content: `| Date | Capture | Commit | Target |\n|---|---|---|---|\n| ${today} | inbox/a.md | abc1234 | src/x.ts |\n| ${today} | inbox/b.md | — | — |\n`, sha: "a" });
    const res = await stats.GET(req("/api/apply-stats?weeks=2"));
    const body = await res.json() as { weeks: Array<{ applied: number; withCommit: number }> };
    expect(body.weeks).toHaveLength(2);
    expect(body.weeks[0]).toMatchObject({ applied: 2, withCommit: 1 });
  });

  // protects: a user who never applied sees zeros, not an error; fails_when: a missing ledger is an error; no_claim: the empty-state copy
  it("returns zero weeks when nothing was applied yet", async () => {
    const res = await stats.GET(req("/api/apply-stats"));
    const body = await res.json() as { weeks: Array<{ applied: number }> };
    expect(body.weeks).toHaveLength(4);
    expect(body.weeks.every((w) => w.applied === 0)).toBe(true);
  });
});

describe("when GitHub fails (not a missing file)", () => {
  // Regression: review finding on PR #155 — a GitHub outage looked like an empty knowledge repo
  // protects: a rate limit, revoked token or outage says so instead of showing an empty repo, no captures or zero applies; fails_when: a non-404 failure reads as missing; no_claim: GitHub's own error codes
  it.each([
    ["the list", "INDEX.md", () => list.GET(req("/api/captures"))],
    ["weekly applies", "APPLIED.md", () => stats.GET(req("/api/apply-stats"))],
    ["check links", "inbox", () => check.POST(req("/api/captures/check", {}))],
    ["archive", `inbox/${CAPTURE}`, () => archive.POST(req("/api/captures/archive", { filename: CAPTURE }))],
    ["delete", `inbox/${CAPTURE}`, () => del.POST(req("/api/captures/delete", { filename: CAPTURE }))],
    ["rules", "INDEX.md", () => rules.POST(req("/api/rules", { tag: "llm" }))],
  ])("%s answers 502 with a GitHub message", async (_name, path, run) => {
    down.add(path);
    const res = await run();
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/GitHub/);
    expect(githubPut).not.toHaveBeenCalled();
    expect(synthesizeTopic).not.toHaveBeenCalled();
  });
});

