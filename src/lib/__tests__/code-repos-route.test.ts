import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * /api/code-repos: Settings lists, adds and removes the user's code repos.
 * Adding reads file paths from GitHub with the user's own sign-in.
 */

const user = { id: 7, github_token: "gho_user" };
let session: typeof user | null = user;
const saveCodeMap = vi.fn();
const listCodeRepos = vi.fn();
const deleteCodeMap = vi.fn();
const consumeQuota = vi.fn();

vi.mock("@/lib/session", () => ({ getSession: async () => session }));
vi.mock("@/lib/db", () => ({
  saveCodeMap: (...a: unknown[]) => saveCodeMap(...a),
  listCodeRepos: (...a: unknown[]) => listCodeRepos(...a),
  deleteCodeMap: (...a: unknown[]) => deleteCodeMap(...a),
}));
vi.mock("@/lib/rate-limit", () => ({ consumeQuota: (...a: unknown[]) => consumeQuota(...a) }));

const { GET, POST, DELETE } = await import("@/app/api/code-repos/route");

const syncedAt = new Date("2026-10-29T10:00:00Z");
const ROW = { repo: "acme/widgets", source: "github", files: 2, truncated: false, syncedAt };
const github = vi.fn();

function req(method: string, body?: unknown): NextRequest {
  return new NextRequest("https://xkg.test/api/code-repos", {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

beforeEach(() => {
  session = user;
  saveCodeMap.mockReset().mockResolvedValue(true);
  listCodeRepos.mockReset().mockResolvedValue([ROW]);
  deleteCodeMap.mockReset().mockResolvedValue(true);
  consumeQuota.mockReset().mockResolvedValue({ allowed: true, limit: 60, remaining: 59, resetIn: 3600 });
  github.mockReset().mockImplementation(async () => new Response(JSON.stringify({ truncated: false, tree: [{ path: "src/a.ts", type: "blob" }, { path: "README.md", type: "blob" }] }), { status: 200 }));
  vi.stubGlobal("fetch", github);
});
afterEach(() => vi.unstubAllGlobals());

describe("GET /api/code-repos", () => {
  // protects: Settings shows each repo with its source and last sync; fails_when: maps or another user's rows are returned; no_claim: ordering (db test)
  it("lists the user's repos without their maps", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(listCodeRepos).toHaveBeenCalledWith(7);
    expect(await res.json()).toEqual({ repos: [{ ...ROW, syncedAt: syncedAt.toISOString() }] });
  });

  // protects: signed-out callers get nothing; fails_when: the list is returned without a session; no_claim: middleware behavior
  it("needs a session", async () => {
    session = null;
    expect((await GET()).status).toBe(401);
    expect(listCodeRepos).not.toHaveBeenCalled();
  });
});

describe("POST /api/code-repos", () => {
  // protects: AC1, adding stores paths only with source github and returns the new list; fails_when: exports are stored, the source is local, or another token is used; no_claim: GitHub filtering (code-repos test)
  it("reads file paths with the user's sign-in and stores them as a GitHub map", async () => {
    const res = await POST(req("POST", { repo: "acme/widgets" }));
    expect(res.status).toBe(200);
    expect(github).toHaveBeenCalledTimes(1);
    expect((github.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer gho_user" });
    expect(saveCodeMap).toHaveBeenCalledWith(7, { repo: "acme/widgets", head7: "", truncated: false, files: [{ p: "src/a.ts" }, { p: "README.md" }] }, expect.stringMatching(/^[0-9a-f]{64}$/), "github");
    expect(await res.json()).toEqual({ repos: [{ ...ROW, syncedAt: syncedAt.toISOString() }] });
  });

  // protects: AC2, a repo the sign-in can't read shows a clear error and nothing is stored; fails_when: a row is saved or GitHub's text is shown; no_claim: wording of other errors
  it("stores nothing when GitHub refuses", async () => {
    github.mockImplementation(async () => new Response("{}", { status: 404 }));
    const res = await POST(req("POST", { repo: "acme/secret" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "xkg can't read acme/secret with your GitHub sign-in. Check the name, and that your account can open it." });
    expect(saveCodeMap).not.toHaveBeenCalled();
  });

  // protects: precedence, a map from the user's machine isn't replaced and the user is told why; fails_when: a GitHub add reports success over a local map; no_claim: the race with a concurrent sync
  it("says so when the repo already has a map from the user's machine", async () => {
    saveCodeMap.mockResolvedValue(false);
    const res = await POST(req("POST", { repo: "acme/widgets" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "acme/widgets already has a map from your machine, which also has its exported names. Nothing changed." });
  });

  // protects: adding shares the map sync rate limit; fails_when: GitHub is called past the limit; no_claim: the limit's size
  it("is rate limited with map syncs", async () => {
    consumeQuota.mockResolvedValue({ allowed: false, limit: 60, remaining: 0, resetIn: 120 });
    const res = await POST(req("POST", { repo: "acme/widgets" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("120");
    expect(consumeQuota).toHaveBeenCalledWith("code-map:user:7", 60);
    expect(github).not.toHaveBeenCalled();
  });

  // protects: bad input never reaches GitHub; fails_when: a non-string or bad name is fetched; no_claim: name normalization (code-repos test)
  it("refuses a body without a usable repo name", async () => {
    for (const body of ["not json", {}, { repo: 42 }, { repo: "acme" }]) {
      const res = await POST(req("POST", body));
      expect(res.status).toBe(400);
    }
    expect(github).not.toHaveBeenCalled();
    session = null;
    expect((await POST(req("POST", { repo: "acme/widgets" }))).status).toBe(401);
  });
});

describe("DELETE /api/code-repos", () => {
  // protects: AC3, removing deletes the user's row; fails_when: another user's row or the wrong repo is deleted; no_claim: what the next capture shows (where test)
  it("removes the repo and returns the new list", async () => {
    listCodeRepos.mockResolvedValue([]);
    const res = await DELETE(req("DELETE", { repo: "acme/widgets" }));
    expect(res.status).toBe(200);
    expect(deleteCodeMap).toHaveBeenCalledWith(7, "acme/widgets");
    expect(await res.json()).toEqual({ repos: [] });
  });

  // protects: an unknown repo says so; fails_when: success is claimed for nothing; no_claim: wording
  it("answers 404 for a repo the user doesn't have", async () => {
    deleteCodeMap.mockResolvedValue(false);
    expect((await DELETE(req("DELETE", { repo: "acme/nope" }))).status).toBe(404);
    session = null;
    expect((await DELETE(req("DELETE", { repo: "acme/widgets" }))).status).toBe(401);
  });
});
