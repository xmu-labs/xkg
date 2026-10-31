import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The refund has to hit the exact row that was charged. Postgres keeps
 * `window_started_at` to the microsecond, but a JavaScript Date keeps
 * milliseconds, so a round-trip through Date would make the equality miss and
 * the failed capture would stay charged. The window is carried as the text
 * Postgres printed, untouched.
 */

type Call = { text: string; values: unknown[] };
const calls: Call[] = [];
let nextRows: unknown[] = [];

vi.mock("../sql", () => ({
  sql: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    return { rows: nextRows, rowCount: nextRows.length };
  },
}));

import { consumeQuota, refundQuota } from "../rate-limit";

const MICRO = "2026-10-31 11:00:00.123456";

beforeEach(() => {
  calls.length = 0;
  nextRows = [];
});

describe("quota refund window", () => {
  // protects: a refund finds the charged row even with microsecond timestamps; fails_when: the window goes through a Date and loses digits; no_claim: none
  it("carries the window as the text Postgres returned, microseconds included", async () => {
    nextRows = [{ used: 3, window_started_at: new Date("2026-10-31T11:00:00.123Z"), window_key: MICRO }];
    const state = await consumeQuota("capture:user:7");
    expect(state.windowKey).toBe(MICRO);
    expect(calls[0].text).toContain("window_started_at::text");
  });

  // protects: only the charged window is decremented; fails_when: the refund compares against a rounded value; no_claim: none
  it("refunds with that exact text as the window predicate", async () => {
    await refundQuota("capture:user:7", MICRO);
    expect(calls).toHaveLength(1);
    expect(calls[0].values).toEqual(["capture:user:7", MICRO]);
    expect(calls[0].text).toMatch(/window_started_at = \?::timestamp/);
  });

  // protects: a missing row never refunds a random window; fails_when: the fallback key matches a real row; no_claim: none
  it("uses an empty window key when the charge returned no row", async () => {
    const state = await consumeQuota("capture:user:7");
    expect(state.windowKey).toBe("");
  });
});
