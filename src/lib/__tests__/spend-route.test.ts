import { describe, it, expect, vi } from "vitest";

/** GET /api/spend: this month's spend with the signed-in user's key (XKG-144). */

let session: { id: number } | null = { id: 7 };
const asked: number[] = [];
vi.mock("@/lib/session", () => ({ getSession: async () => session }));
const saved: Array<[number, number | null]> = [];
let budget: number | null = null;
vi.mock("@/lib/llm-spend", async () => ({
  parseBudget: (await vi.importActual<typeof import("@/lib/llm-spend")>("@/lib/llm-spend")).parseBudget,
  monthSpend: async (userId: number) => {
    asked.push(userId);
    return { calls: 3, tokensIn: 900, tokensOut: 100, costUsd: 0.01, unpricedCalls: 0 };
  },
  getBudget: async () => budget,
  setBudget: async (userId: number, value: number | null) => { saved.push([userId, value]); budget = value; },
}));

const { GET, PUT } = await import("@/app/api/spend/route");

function put(body: unknown) {
  return PUT(new Request("https://xkg.test/api/spend", { method: "PUT", body: JSON.stringify(body) }) as never);
}

describe("GET /api/spend", () => {
  // protects: Settings gets the user's own month; fails_when: another user's id is read or fields are dropped; no_claim: none
  it("returns the signed-in user's month", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ month: { calls: 3, tokensIn: 900, tokensOut: 100, costUsd: 0.01, unpricedCalls: 0 }, budgetUsd: null });
    expect(asked).toEqual([7]);
  });

  // protects: XKG-145, saving and clearing the budget; fails_when: the budget isn't saved for the user or isn't returned; no_claim: none
  it("saves a budget and clears it", async () => {
    const res = await put({ budgetUsd: 5 });
    expect(res.status).toBe(200);
    expect((await res.json()).budgetUsd).toBe(5);
    await put({ budgetUsd: null });
    expect(saved).toEqual([[7, 5], [7, null]]);
  });

  // protects: bad input is refused in a sentence; fails_when: a negative budget is saved; no_claim: none
  it("refuses a budget that isn't a positive amount", async () => {
    const res = await put({ budgetUsd: -3 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Enter a monthly budget between $0.01 and $10,000, or leave it empty.");
  });

  // Regression: QA XKG-145 — a PUT without a body cleared the saved budget
  // protects: only an explicit null clears; fails_when: a missing or malformed body clears the budget; no_claim: none
  it("refuses a body without budgetUsd instead of clearing", async () => {
    saved.length = 0;
    expect((await put({})).status).toBe(400);
    const res = await PUT(new Request("https://xkg.test/api/spend", { method: "PUT", body: "not json" }) as never);
    expect(res.status).toBe(400);
    expect(saved).toEqual([]);
  });

  // protects: spend is private; fails_when: a signed-out request gets numbers; no_claim: none
  it("needs a session", async () => {
    session = null;
    expect((await GET()).status).toBe(401);
    expect((await put({ budgetUsd: 5 })).status).toBe(401);
  });
});
