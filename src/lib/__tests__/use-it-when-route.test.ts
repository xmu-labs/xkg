import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * POST /api/captures/use-it-when: the web app's backfill. `{ estimate: true }`
 * answers how many captures and what it could cost, with no model call;
 * `{ after? }` runs one page. Signed in, with a key, under an hourly cap.
 */

const user = { id: 7, github_token: "t", github_repo: "o/r", llm_api_key: "k", llm_provider: "openai" };
let session: Record<string, unknown> | null = user;
let allowed = true;
const backfillPage = vi.fn(async () => ({ written: 2, skipped: 0, none: 0, failed: 0, next: "inbox/x.md", total: 9 }));
const backfillEstimate = vi.fn(async () => ({ captures: 9, usd: 0.004, reasoning: false }));

vi.mock("@/lib/session", () => ({ getSession: async () => session }));
vi.mock("@/lib/rate-limit", () => ({ consumeQuota: async () => ({ allowed, limit: 60, resetIn: 30 }) }));
vi.mock("@/lib/llm-spend", () => ({ withSpendMeter: (_id: number, fn: () => unknown) => fn() }));
vi.mock("@/lib/use-it-when-backfill", () => ({
  backfillPage: (...a: unknown[]) => backfillPage(...(a as [])),
  backfillEstimate: (...a: unknown[]) => backfillEstimate(...(a as [])),
}));

const { POST } = await import("@/app/api/captures/use-it-when/route");
const post = (body: unknown) =>
  POST(new NextRequest("http://x/api/captures/use-it-when", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }));

beforeEach(() => {
  session = user;
  allowed = true;
  backfillPage.mockClear();
  backfillEstimate.mockClear();
});

describe("POST /api/captures/use-it-when", () => {
  it("answers the estimate without running a page", async () => {
    const res = await post({ estimate: true });
    expect(res.status).toBe(200);
    // `scope` names the account and repo, so one browser keeps each repo's progress apart.
    expect(await res.json()).toEqual({ captures: 9, usd: 0.004, reasoning: false, scope: "7:o/r" });
    expect(backfillPage).not.toHaveBeenCalled();
  });

  it("runs one page from `after`", async () => {
    const res = await post({ after: "inbox/a.md" });
    expect(res.status).toBe(200);
    expect((await res.json()).next).toBe("inbox/x.md");
    expect(backfillPage).toHaveBeenCalledWith(user, { after: "inbox/a.md", limit: 5 });
  });

  it("ignores an `after` that isn't a capture path", async () => {
    await post({ after: "../secrets" });
    expect(backfillPage).toHaveBeenCalledWith(user, { after: undefined, limit: 5 });
  });

  it("refuses without a session, without a key, and over the hourly cap", async () => {
    session = null;
    expect((await post({})).status).toBe(401);
    session = { ...user, llm_api_key: null };
    expect((await post({})).status).toBe(400);
    session = user;
    allowed = false;
    const capped = await post({});
    expect(capped.status).toBe(429);
    expect(capped.headers.get("Retry-After")).toBe("30");
    expect(backfillPage).not.toHaveBeenCalled();
  });
});
