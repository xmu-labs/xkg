import { describe, it, expect, vi, beforeEach } from "vitest";

/** XKG-145: an optional monthly budget per user, kept in its own table so no migration is needed. */

const queries: Array<{ text: string; values: unknown[] }> = [];
let rows: Array<Record<string, unknown>> = [];
vi.mock("../sql", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    queries.push({ text, values });
    return Promise.resolve({ rows: text.startsWith("SELECT") ? rows : [], rowCount: 0 });
  },
}));

const { getBudget, setBudget, parseBudget } = await import("../llm-spend");

beforeEach(() => { queries.length = 0; rows = []; });

describe("monthly budget", () => {
  // protects: the saved budget is read back; fails_when: a stored value is dropped; no_claim: none
  it("reads the saved budget, or null", async () => {
    rows = [{ monthly_usd: 5 }];
    expect(await getBudget(7)).toBe(5);
    rows = [];
    expect(await getBudget(7)).toBeNull();
  });

  // protects: saving and clearing; fails_when: a budget can't be cleared or is saved for another user; no_claim: none
  it("upserts a budget and deletes it when cleared", async () => {
    await setBudget(7, 5);
    expect(queries.some((q) => q.text.startsWith("INSERT INTO llm_budgets") && q.values.includes(7) && q.values.includes(5))).toBe(true);
    await setBudget(7, null);
    expect(queries.some((q) => q.text.startsWith("DELETE FROM llm_budgets") && q.values.includes(7))).toBe(true);
  });

  // protects: only sane budgets are stored; fails_when: a negative, zero, huge or non-number budget is accepted; no_claim: none
  it.each([
    [5, 5], ["5", 5], [12.345, 12.35], [null, null], ["", null],
  ] as const)("parses %j as %j", (input, out) => {
    expect(parseBudget(input)).toEqual({ ok: true, value: out });
  });

  it.each([0, -1, 10001, "abc", true, {}])("rejects %j", (input) => {
    expect(parseBudget(input).ok).toBe(false);
  });
});
