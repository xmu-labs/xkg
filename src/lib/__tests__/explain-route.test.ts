import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/** POST /api/captures/explain: Why and After for a capture's files, written into its file once. */

const user = { id: 7, github_token: "gho_user", github_repo: "o/knowledge", llm_api_key: "sk", llm_provider: "openai", llm_model: "m", llm_effort: null };
let session: Record<string, unknown> | null = user;
const files = new Map<string, { content: string; sha: string }>();
const puts: { path: string; content: string; sha?: string }[] = [];
let quotaAllowed = true;
let explained: unknown = null;
const explainCalls: string[] = [];

vi.mock("@/lib/session", () => ({ getSession: async () => session }));
vi.mock("@/lib/rate-limit", () => ({ consumeQuota: async () => ({ allowed: quotaAllowed, limit: 60, resetIn: 30, windowKey: "w" }) }));
vi.mock("@/lib/explain", () => ({
  explainCapture: async (_u: unknown, markdown: string) => {
    explainCalls.push(markdown);
    return explained;
  },
}));
vi.mock("@/lib/github", async () => {
  const { GitHubReadError } = await vi.importActual<typeof import("@/lib/github")>("@/lib/github");
  return {
    GitHubReadError,
    readFileStrict: async (_t: string, _r: string, path: string) => files.get(path) ?? null,
    githubPut: async (_t: string, _r: string, path: string, content: string, _m: string, sha?: string) => {
      puts.push({ path, content, sha });
    },
  };
});

const { POST } = await import("@/app/api/captures/explain/route");

const NAME = "2026-10-30-rag.md";
const post = (body: unknown) =>
  POST(new NextRequest("https://xkg.test/api/captures/explain", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  session = user;
  files.clear();
  puts.length = 0;
  explainCalls.length = 0;
  quotaAllowed = true;
  explained = null;
  files.set("INDEX.md", { content: `| Date | Capture |\n|---|---|\n| 2026-10-30 | [rag](inbox/${NAME}) |\n`, sha: "i" });
  files.set(`inbox/${NAME}`, { content: "OLD", sha: "s1" });
});

describe("POST /api/captures/explain", () => {
  it("returns the lines and writes the updated file with its sha", async () => {
    explained = { files: [{ path: "src/a.ts", why: "w", after: "a" }], markdown: "NEW", tokens: { in: 400, out: 50 } };
    const res = await post({ name: NAME });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ files: [{ path: "src/a.ts", why: "w", after: "a" }] });
    expect(explainCalls).toEqual(["OLD"]);
    expect(puts).toEqual([{ path: `inbox/${NAME}`, content: "NEW", sha: "s1" }]);
  });

  it("doesn't write when nothing changed", async () => {
    explained = { files: [{ path: "src/a.ts", why: "w", after: "a" }], markdown: "OLD" };
    expect((await post({ name: NAME })).status).toBe(200);
    expect(puts).toEqual([]);
  });

  it("still answers when the write fails", async () => {
    explained = { files: [{ path: "src/a.ts", why: "w", after: "a" }], markdown: "NEW" };
    const github = await import("@/lib/github");
    vi.spyOn(github, "githubPut").mockRejectedValueOnce(new Error("409"));
    const res = await post({ name: NAME });
    expect(res.status).toBe(200);
  });

  it("says when the lines couldn't be written", async () => {
    explained = null;
    const res = await post({ name: NAME });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/Couldn't explain/);
  });

  it("rejects a bad name, a missing capture, no session, and too many requests", async () => {
    expect((await post({ name: "../x" })).status).toBe(400);
    expect((await post({ name: "2026-01-01-gone.md" })).status).toBe(404);
    quotaAllowed = false;
    expect((await post({ name: NAME })).status).toBe(429);
    session = null;
    expect((await post({ name: NAME })).status).toBe(401);
    expect(explainCalls).toEqual([]);
  });
});
