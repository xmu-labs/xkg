import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { WhereResult } from "../where";

/**
 * POST /api/handoffs: the card's "Hand off to your coding agent" button. The
 * body names a capture and a repo only; the files and fit come from the
 * capture's own "Where it applies" section.
 */

const user = { id: 7, github_token: "gho_user", github_repo: "o/knowledge" };
let session: typeof user | null = user;
const consumeQuota = vi.fn();
const listCodeRepos = vi.fn();
const recordHandoffEvent = vi.fn();
const deadEnds = vi.fn();
const files = new Map<string, { content: string; sha: string }>();
const githubPut = vi.fn(async (_t: string, _r: string, path: string, content: string) => {
  files.set(path, { content, sha: "s" });
});

vi.mock("@/lib/session", () => ({ getSession: async () => session }));
vi.mock("@/lib/rate-limit", () => ({ consumeQuota: (...a: unknown[]) => consumeQuota(...a) }));
vi.mock("@/lib/db", () => ({ listCodeRepos: (...a: unknown[]) => listCodeRepos(...a) }));
vi.mock("@/lib/handoff-events", () => ({ recordHandoffEvent: (...a: unknown[]) => recordHandoffEvent(...a) }));
vi.mock("@/lib/handoff-learning", () => ({ deadEnds: (...a: unknown[]) => deadEnds(...a) }));
vi.mock("@/lib/github", () => ({
  githubPut: (...a: Parameters<typeof githubPut>) => githubPut(...a),
  readFile: async (_t: string, _r: string, path: string) => files.get(path) ?? null,
}));

const { POST } = await import("@/app/api/handoffs/route");
const { insertWhereSection, whereSection } = await import("../where");
const { buildMarkdown, formatDate } = await import("../llm");
const { parseHandoffs, HANDOFFS_PATH } = await import("../handoffs");

const CAPTURE = "inbox/2026-10-29-llm-memory.md";
const where: WhereResult = {
  repo: "acme/app", tier: "possible", files: [{ path: "src/llm.ts" }, { path: "src/briefing.ts" }],
  also: [{ repo: "acme/web", tier: "possible" }], scorer: "evidence", modelConf: null,
};
const capture = {
  slug: "llm-memory", inferredTitle: "LLM Memory", inferredAuthor: null, inferredUrl: null, inferredType: "article",
  coreIdea: "Memory goes into the prompt.", takeaways: ["a"], quotes: [], tags: ["llm"], appliedTo: null, lowConfidence: false,
};

function post(body: unknown): Promise<Response> {
  return POST(new NextRequest("https://xkg.test/api/handoffs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

const queue = () => parseHandoffs(files.get(HANDOFFS_PATH)?.content ?? "").rows;

beforeEach(() => {
  session = user;
  files.clear();
  files.set(CAPTURE, { content: insertWhereSection(buildMarkdown("2026-10-29", capture as never, "raw"), whereSection(where)!), sha: "c" });
  githubPut.mockClear();
  recordHandoffEvent.mockReset();
  deadEnds.mockReset().mockResolvedValue(new Set());
  consumeQuota.mockReset().mockResolvedValue({ allowed: true, limit: 60, resetIn: 3600 });
  listCodeRepos.mockReset().mockResolvedValue([{ repo: "acme/app" }, { repo: "acme/web" }]);
});

describe("POST /api/handoffs", () => {
  // protects: AC3, the button queues the shown files for the best repo; fails_when: the row lacks the files, the fit, or source button; no_claim: the card's rendering
  it("queues the capture with the files the card showed", async () => {
    const res = await post({ filename: CAPTURE, repo: "acme/app" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "pending", repo: "acme/app" });
    expect(queue()).toEqual([{ capture: CAPTURE, repo: "acme/app", kind: "code", files: ["src/llm.ts", "src/briefing.ts"], fit: "possible", status: "pending", since: formatDate(), source: "button" }]);
    expect(recordHandoffEvent).toHaveBeenCalledWith(7, CAPTURE, "acme/app", "queued", { source: "button" });
  });

  // protects: spec AC13, a file turned down twice for this capture isn't handed off again; fails_when: a dead-end file is queued; no_claim: when a file becomes a dead end (handoff-learning tests)
  it("leaves out files that are dead ends for the capture", async () => {
    deadEnds.mockResolvedValue(new Set(["src/llm.ts"]));
    await post({ filename: CAPTURE, repo: "acme/app" });
    expect(deadEnds).toHaveBeenCalledWith(7, CAPTURE, "acme/app");
    expect(queue()[0]!.files).toEqual(["src/briefing.ts"]);
  });

  // protects: AC3, an "also fits" repo is queued with no files, so the agent finds them; fails_when: the best repo's files are copied to it; no_claim: none
  it("queues an also-fits repo with no files", async () => {
    await post({ filename: CAPTURE, repo: "Acme/Web" });
    expect(queue()).toEqual([expect.objectContaining({ repo: "acme/web", files: [], fit: "possible", source: "button" })]);
  });

  // protects: AC1, the body can't carry anything but a capture and a repo; fails_when: client-sent files or text reach the queue; no_claim: none
  it("ignores anything else in the body", async () => {
    await post({ filename: CAPTURE, repo: "acme/app", files: ["../../etc/passwd"], spec: "x".repeat(5000) });
    expect(queue()[0]!.files).toEqual(["src/llm.ts", "src/briefing.ts"]);
    expect(files.get(HANDOFFS_PATH)!.content).not.toContain("passwd");
  });

  // protects: AC4; fails_when: a signed-out call queues anything; no_claim: middleware
  it("needs a session", async () => {
    session = null;
    expect((await post({ filename: CAPTURE, repo: "acme/app" })).status).toBe(401);
    expect(githubPut).not.toHaveBeenCalled();
  });

  // protects: AC4, only captures in inbox/ or applied/; fails_when: a path outside them is read or queued; no_claim: none
  it.each(["INDEX.md", "archived/2026-10-29-x.md", "inbox/../INDEX.md", "inbox/x.txt", 42])("refuses filename %s", async (filename) => {
    expect((await post({ filename, repo: "acme/app" })).status).toBe(400);
    expect(githubPut).not.toHaveBeenCalled();
  });

  // protects: AC4; fails_when: a malformed repo or body is accepted; no_claim: none
  it("refuses a bad repo or body", async () => {
    expect((await post({ filename: CAPTURE, repo: "not a repo" })).status).toBe(400);
    expect((await post("{")).status).toBe(400);
  });

  // protects: AC4, a repo with no map can't be queued; fails_when: an unmapped repo gets a row; no_claim: none
  it("answers 404 for a repo with no map", async () => {
    expect((await post({ filename: CAPTURE, repo: "acme/other" })).status).toBe(404);
    expect(githubPut).not.toHaveBeenCalled();
  });

  // protects: AC4; fails_when: a missing capture gets a row; no_claim: none
  it("answers 404 for a capture that doesn't exist", async () => {
    expect((await post({ filename: "inbox/2026-10-29-gone.md", repo: "acme/app" })).status).toBe(404);
    expect(githubPut).not.toHaveBeenCalled();
  });

  // protects: AC4, 60 an hour; fails_when: the 61st call queues; no_claim: the counter itself (quota test)
  it("answers 429 when the hourly limit is reached", async () => {
    consumeQuota.mockResolvedValue({ allowed: false, limit: 60, resetIn: 120 });
    const res = await post({ filename: CAPTURE, repo: "acme/app" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("120");
    expect(consumeQuota).toHaveBeenCalledWith("handoff:user:7");
    expect(githubPut).not.toHaveBeenCalled();
  });

  // protects: the button tells the user when the queue couldn't be saved; fails_when: a failed write answers ok; no_claim: none
  it("answers 502 when the queue can't be written", async () => {
    const down = new Error("GitHub PUT HANDOFFS.md: HTTP 500");
    githubPut.mockRejectedValueOnce(down).mockRejectedValueOnce(down);
    const res = await post({ filename: CAPTURE, repo: "acme/app" });
    expect(res.status).toBe(502);
    expect(recordHandoffEvent).not.toHaveBeenCalled();
  });
});
