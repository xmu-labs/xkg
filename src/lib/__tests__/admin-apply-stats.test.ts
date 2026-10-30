import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * GET /api/admin/apply-stats is the operator's read of the apply metric:
 * counts per user and week, behind the same admin secret as /api/init-db.
 */

const applyGateStats = vi.fn();
const applySourceStats = vi.fn();
const matchingStats = vi.fn();
const handoffStats = vi.fn();
vi.mock("@/lib/apply-events", () => ({ applyGateStats: (...a: unknown[]) => applyGateStats(...a) }));
vi.mock("@/lib/handoff-events", () => ({ handoffStats: (...a: unknown[]) => handoffStats(...a) }));
vi.mock("@/lib/surface-events", () => ({
  applySourceStats: (...a: unknown[]) => applySourceStats(...a),
  matchingStats: (...a: unknown[]) => matchingStats(...a),
}));

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
  applySourceStats.mockReset();
  applySourceStats.mockResolvedValue([{ userId: 7, weekStart: "2026-10-26", sources: { cardOnly: 1, briefingOnly: 0, both: 0, other: 0, none: 0 } }]);
  matchingStats.mockReset();
  matchingStats.mockResolvedValue([{ userId: 7, weekStart: "2026-10-26", matches: 3, suggestions: 2, medianTokens: 3443 }]);
  handoffStats.mockReset();
  handoffStats.mockResolvedValue([]);
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
    expect(body.weeks).toEqual([{
      userId: 7, weekStart: "2026-10-26", captures: 1, capturesWithCommit: 1, capturesWithWhy: 0, harnesses: { codex: 1 },
      sources: { cardOnly: 1, briefingOnly: 0, both: 0, other: 0, none: 0 },
    }]);
    expect(applyGateStats).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), 4);
  });

  // protects: AC8 and AC21 reach the operator; fails_when: the source buckets or matching cost are missing from the response; no_claim: the numbers (see surface-events tests)
  it("adds what surfaced each week's applies, and the matching cost", async () => {
    applySourceStats.mockResolvedValue([]);
    const body = await (await GET(get("?weeks=2", "admin-test-secret"))).json();
    // A week with no source row gets empty buckets, never a guess
    expect(body.weeks[0].sources).toEqual({ cardOnly: 0, briefingOnly: 0, both: 0, other: 0, none: 0 });
    expect(body.matching).toEqual([{ userId: 7, weekStart: "2026-10-26", matches: 3, suggestions: 2, medianTokens: 3443 }]);
    expect(applySourceStats).toHaveBeenCalledWith(expect.any(String), 2);
    expect(matchingStats).toHaveBeenCalledWith(expect.any(String), 2);
  });

  // protects: the handoff numbers reach the operator, per user and week; fails_when: the handoffs bucket is missing or read for another window; no_claim: the numbers (see handoff-events tests)
  it("adds each week's handoffs", async () => {
    const week = { userId: 7, weekStart: "2026-10-26", counts: { offered: 2, applied: 1 } };
    handoffStats.mockResolvedValue([week]);
    const body = await (await GET(get("?weeks=3", "admin-test-secret"))).json();
    expect(body.handoffs).toEqual([week]);
    expect(handoffStats).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), 3);
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
