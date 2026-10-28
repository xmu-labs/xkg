import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * GET /api/admin/apply-stats is the operator's read of the apply metric:
 * counts per user and week, behind the same admin secret as /api/init-db.
 */

const applyGateStats = vi.fn();
vi.mock("@/lib/apply-events", () => ({ applyGateStats: (...a: unknown[]) => applyGateStats(...a) }));

beforeAll(() => {
  process.env.ADMIN_SECRET = "admin-test-secret";
});

const { GET } = await import("@/app/api/admin/apply-stats/route");
const { adminAuthorized } = await import("@/lib/admin-auth");

function get(query = "", secret?: string): NextRequest {
  return new NextRequest(`https://xkg.test/api/admin/apply-stats${query}`, {
    headers: secret === undefined ? {} : { "x-admin-secret": secret },
  });
}

beforeEach(() => {
  applyGateStats.mockReset();
  applyGateStats.mockResolvedValue([{ userId: 7, weekStart: "2026-10-26", captures: 1, capturesWithCommit: 1, capturesWithWhy: 0, harnesses: { codex: 1 } }]);
});

describe("adminAuthorized", () => {
  it("accepts only the exact admin secret", () => {
    expect(adminAuthorized(get("", "admin-test-secret"))).toBe(true);
    expect(adminAuthorized(get("", "admin-test-secre"))).toBe(false);
    expect(adminAuthorized(get())).toBe(false);
  });
});

describe("GET /api/admin/apply-stats", () => {
  it("rejects a wrong or missing secret without reading the counts", async () => {
    expect((await GET(get("", "nope"))).status).toBe(401);
    expect((await GET(get())).status).toBe(401);
    expect(applyGateStats).not.toHaveBeenCalled();
  });

  it("returns the weekly counts, 4 weeks by default", async () => {
    const res = await GET(get("", "admin-test-secret"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.weeks).toEqual([{ userId: 7, weekStart: "2026-10-26", captures: 1, capturesWithCommit: 1, capturesWithWhy: 0, harnesses: { codex: 1 } }]);
    expect(applyGateStats).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), 4);
  });

  it("takes ?weeks= and keeps it between 1 and 52", async () => {
    await GET(get("?weeks=8", "admin-test-secret"));
    await GET(get("?weeks=999", "admin-test-secret"));
    await GET(get("?weeks=abc", "admin-test-secret"));
    expect(applyGateStats.mock.calls.map((c) => c[1])).toEqual([8, 52, 4]);
  });

  it("answers JSON when the read fails", async () => {
    applyGateStats.mockRejectedValue(new Error("db down"));
    const res = await GET(get("", "admin-test-secret"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to read apply stats" });
  });
});
