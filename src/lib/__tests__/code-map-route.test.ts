import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * POST /api/code-map: the CLI's git hooks send a repo's map (paths and
 * exported names) here. The route authenticates with the xkg API key, caps
 * size and rate, and stores only paths and identifiers.
 */

const saveCodeMap = vi.fn();
const consumeQuota = vi.fn();

vi.mock("@/lib/db", () => ({
  getUserByApiKey: async (key: string) => (key === "good-key" ? { id: 7 } : null),
  saveCodeMap: (...a: unknown[]) => saveCodeMap(...a),
}));
vi.mock("@/lib/rate-limit", () => ({
  consumeQuota: (...a: unknown[]) => consumeQuota(...a),
}));

const { POST } = await import("@/app/api/code-map/route");

const MAP = {
  repo: "acme/widgets",
  head7: "abc1234",
  truncated: false,
  files: [
    { p: "src/lib/llm.ts", e: ["callModel"], i: ["src/lib/text.ts"] },
    { p: "src/lib/text.ts", e: ["segment"] },
    { p: "README.md" },
  ],
};

function send(body: unknown, key: string | null = "good-key"): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  return new NextRequest("https://xkg.test/api/code-map", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  saveCodeMap.mockReset();
  consumeQuota.mockReset();
  consumeQuota.mockResolvedValue({ allowed: true, used: 1, limit: 60, resetIn: 3600 });
});

describe("POST /api/code-map", () => {
  // protects: a valid map is stored for its owner; fails_when: the map is stored under another user, altered, or the response shape changes; no_claim: the SQL (db test)
  it("stores the map for the key's owner and says how many files it holds", async () => {
    const res = await POST(send(MAP));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, files: 3, truncated: false });
    expect(saveCodeMap).toHaveBeenCalledWith(7, MAP, expect.stringMatching(/^[0-9a-f]{64}$/));
  });

  // protects: one repo is one row whatever case its remote uses, so a GitHub add can't sit beside the local map; fails_when: Acme/Widgets and acme/widgets are stored apart; no_claim: hosts with case-sensitive names
  it("stores the repo name in lowercase, as GitHub matches it", async () => {
    await POST(send({ ...MAP, repo: "Acme/Widgets" }));
    expect(saveCodeMap.mock.calls[0]![1].repo).toBe("acme/widgets");
  });

  it("stores only paths, names and links, dropping anything else a client sends", async () => {
    await POST(send({ ...MAP, extra: "x", files: [{ p: "a.ts", e: ["a"], body: "const secret = 1" }] }));
    expect(saveCodeMap.mock.calls[0]![1]).toEqual({ repo: "acme/widgets", head7: "abc1234", truncated: false, files: [{ p: "a.ts", e: ["a"] }] });
  });

  // protects: who may write a map; fails_when: a missing or wrong key is accepted; no_claim: OAuth tokens (not accepted here)
  it.each([[null], ["wrong-key"]])("rejects key %s with 401", async (key) => {
    const res = await POST(send(MAP, key));
    expect(res.status).toBe(401);
    expect(saveCodeMap).not.toHaveBeenCalled();
  });

  // protects: the 60/hour cap; fails_when: the 61st call in an hour is stored; no_claim: the window arithmetic (rate-limit tests)
  it("charges the user's code-map quota and refuses the 61st call in an hour", async () => {
    consumeQuota.mockResolvedValue({ allowed: false, used: 61, limit: 60, resetIn: 120 });
    const res = await POST(send(MAP));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("120");
    expect(consumeQuota).toHaveBeenCalledWith("code-map:user:7", 60);
    expect(saveCodeMap).not.toHaveBeenCalled();
  });

  it("refuses a body over 150 KB with 413", async () => {
    const files = Array.from({ length: 2000 }, (_, n) => ({ p: `src/some/fairly/long/directory/name/file-${n}.ts`, e: ["exportedName"] }));
    const res = await POST(send({ ...MAP, files }));
    expect(res.status).toBe(413);
    expect(saveCodeMap).not.toHaveBeenCalled();
  });

  // protects: the server's own names-only and shape checks; fails_when: an unsafe path, a non-identifier name, a link outside the map, or too many files is stored; no_claim: what the CLI sends (CLI tests)
  it.each([
    ["more than 3,000 files", { ...MAP, files: Array.from({ length: 3001 }, (_, n) => ({ p: `f${n}` })) }],
    ["a path with ..", { ...MAP, files: [{ p: "../etc/passwd" }] }],
    ["an absolute path", { ...MAP, files: [{ p: "/etc/passwd" }] }],
    ["a name that is not an identifier", { ...MAP, files: [{ p: "a.ts", e: ["const x = 1"] }] }],
    ["an import outside the map", { ...MAP, files: [{ p: "a.ts", i: ["openai"] }] }],
    ["a repo that is not owner/name", { ...MAP, repo: "https://github.com/acme/widgets" }],
    ["a duplicate path", { ...MAP, files: [{ p: "a.ts" }, { p: "a.ts" }] }],
    ["no files list", { repo: "acme/widgets" }],
  ])("refuses %s with 400", async (_label, body) => {
    const res = await POST(send(body));
    expect(res.status).toBe(400);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: false });
    expect(saveCodeMap).not.toHaveBeenCalled();
  });

  it("answers invalid JSON with a JSON 400, not an HTML error page", async () => {
    const res = await POST(send("{not json"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false });
  });
});
