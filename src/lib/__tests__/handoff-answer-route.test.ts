import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * POST /api/handoffs/answer: the capture card's "Not a fit". It records the
 * same decline an agent records through apply_capture, so the web and every
 * coding agent write one Handoff log line and teach xkg the same way.
 */

const user = { id: 7, github_token: "gho_user", github_repo: "o/knowledge" };
let session: Record<string, unknown> | null = user;
const recordAnswer = vi.fn();
const consumeQuota = vi.fn();

vi.mock("@/lib/session", () => ({ getSession: async () => session }));
vi.mock("@/lib/rate-limit", () => ({ consumeQuota: (...a: unknown[]) => consumeQuota(...a) }));
vi.mock("@/lib/handoff-outcomes", () => ({
  DECLINE_REASONS: ["wrong-files", "doesnt-fit", "other"],
  recordAnswer: (...a: unknown[]) => recordAnswer(...a),
}));

const { POST } = await import("@/app/api/handoffs/answer/route");

const CAPTURE = "inbox/2026-11-03-agent-loops.md";

function post(body: unknown): Promise<Response> {
  return POST(new NextRequest("https://xkg.test/api/handoffs/answer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

beforeEach(() => {
  session = user;
  recordAnswer.mockReset().mockResolvedValue("Recorded: 2026-11-03-agent-loops.md declined in acme/app (wrong-files). It doesn't count as an apply.");
  consumeQuota.mockReset().mockResolvedValue({ allowed: true, limit: 60, resetIn: 3600 });
});

describe("POST /api/handoffs/answer", () => {
  // fails_when: the web decline takes a different path than apply_capture's (no Handoff log, no learning)
  it("records a decline through the same path as apply_capture", async () => {
    const res = await post({ filename: CAPTURE, repo: "Acme/App", reason: "wrong-files" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "declined", repo: "acme/app" });
    expect(recordAnswer).toHaveBeenCalledWith(user, { filename: CAPTURE, outcome: "declined", repo: "acme/app", reason: "wrong-files" });
  });

  // fails_when: a web "Wrong files" on a never-queued match records no files, so learning gets no signal
  it("passes the suggested files of a wrong-files decline on to be checked against the code map", async () => {
    await post({ filename: CAPTURE, repo: "acme/app", reason: "wrong-files", files: ["src/a.ts", 3, "src/b.ts"] });
    expect(recordAnswer).toHaveBeenCalledWith(user, { filename: CAPTURE, outcome: "declined", repo: "acme/app", reason: "wrong-files", files: ["src/a.ts", "src/b.ts"] });
  });

  it("refuses a reason the agent couldn't send either", async () => {
    const res = await post({ filename: CAPTURE, repo: "acme/app", reason: "meh" });
    expect(res.status).toBe(400);
    expect(recordAnswer).not.toHaveBeenCalled();
  });

  it.each([
    [{ filename: "../RULES.md", repo: "acme/app", reason: "other" }],
    [{ filename: "archived/2026-11-03-agent-loops.md", repo: "acme/app", reason: "other" }],
    [{ filename: CAPTURE, repo: "not a repo", reason: "other" }],
    ["not json"],
  ])("refuses a body that doesn't name a capture and a repo (%j)", async (body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(recordAnswer).not.toHaveBeenCalled();
  });

  it("says plainly when nothing could be recorded, so the user can try again", async () => {
    recordAnswer.mockResolvedValue("Nothing was recorded: HANDOFFS.md couldn't be updated. Try again in a moment.");
    const res = await post({ filename: CAPTURE, repo: "acme/app", reason: "doesnt-fit" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Nothing was recorded: HANDOFFS.md couldn't be updated. Try again in a moment." });
  });

  it("needs a signed-in user with a knowledge repo", async () => {
    session = null;
    expect((await post({ filename: CAPTURE, repo: "acme/app", reason: "other" })).status).toBe(401);
    session = { ...user, github_repo: null };
    expect((await post({ filename: CAPTURE, repo: "acme/app", reason: "other" })).status).toBe(400);
  });

  it("is rate limited like the hand-off button", async () => {
    consumeQuota.mockResolvedValue({ allowed: false, limit: 60, resetIn: 120 });
    const res = await post({ filename: CAPTURE, repo: "acme/app", reason: "other" });
    expect(res.status).toBe(429);
    expect(consumeQuota).toHaveBeenCalledWith("handoff:user:7");
    expect(recordAnswer).not.toHaveBeenCalled();
  });
});
