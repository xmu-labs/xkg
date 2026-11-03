import { describe, it, expect, vi } from "vitest";

/** GET /api/spend: this month's spend with the signed-in user's key (XKG-144). */

let session: { id: number } | null = { id: 7 };
const asked: number[] = [];
vi.mock("@/lib/session", () => ({ getSession: async () => session }));
vi.mock("@/lib/llm-spend", () => ({
  monthSpend: async (userId: number) => {
    asked.push(userId);
    return { calls: 3, tokensIn: 900, tokensOut: 100, costUsd: 0.01, unpricedCalls: 0 };
  },
}));

const { GET } = await import("@/app/api/spend/route");

describe("GET /api/spend", () => {
  // protects: Settings gets the user's own month; fails_when: another user's id is read or fields are dropped; no_claim: none
  it("returns the signed-in user's month", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ month: { calls: 3, tokensIn: 900, tokensOut: 100, costUsd: 0.01, unpricedCalls: 0 } });
    expect(asked).toEqual([7]);
  });

  // protects: spend is private; fails_when: a signed-out request gets numbers; no_claim: none
  it("needs a session", async () => {
    session = null;
    expect((await GET()).status).toBe(401);
  });
});
