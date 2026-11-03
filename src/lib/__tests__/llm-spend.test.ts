import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * XKG-144: every model call xkg makes with a user's key is counted against
 * that user (provider, model, the provider's own token counts and an
 * estimated cost), so Settings can show this month's spend. Counting never
 * fails the call, and a call outside a user's request counts nothing.
 */

const queries: Array<{ text: string; values: unknown[] }> = [];
let failInsert = false;
let monthRows: Array<Record<string, unknown>> = [];
vi.mock("../sql", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    queries.push({ text, values });
    if (failInsert && text.startsWith("INSERT INTO llm_spend")) return Promise.reject(new Error("db down"));
    if (text.startsWith("SELECT")) return Promise.resolve({ rows: monthRows, rowCount: monthRows.length });
    return Promise.resolve({ rows: [], rowCount: 0 });
  },
}));

const { callLlm } = await import("../llm");
const { withSpendMeter, monthSpend } = await import("../llm-spend");

const inserts = () => queries.filter((q) => q.text.startsWith("INSERT INTO llm_spend"));

function openaiAnswer(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 2000, completion_tokens: 500 } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const call = () => callLlm({ llm: "openai", apiKey: "k", system: "s", user: "u", maxTokens: 100 });

describe("spend meter", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    queries.length = 0;
    failInsert = false;
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => openaiAnswer());
  });
  afterEach(() => fetchSpy.mockRestore());

  // protects: a call made for a user is counted for that user; fails_when: no row, or wrong user/model/tokens/cost; no_claim: the provider's counts are right
  it("records each call made inside a user's request", async () => {
    await withSpendMeter(7, async () => { await call(); });
    expect(inserts()).toHaveLength(1);
    const [userId, provider, model, tokensIn, tokensOut, cost] = inserts()[0]!.values;
    expect({ userId, provider, model, tokensIn, tokensOut }).toEqual({ userId: 7, provider: "openai", model: "gpt-4o-mini", tokensIn: 2000, tokensOut: 500 });
    expect(cost).toBeCloseTo(0.0006, 6);
  });

  // protects: only a user's own calls are counted; fails_when: a call outside a request is charged to someone; no_claim: none
  it("records nothing outside a user's request", async () => {
    await call();
    expect(inserts()).toHaveLength(0);
  });

  // protects: one request's user never leaks into the next; fails_when: the meter outlives the wrapped function; no_claim: Next's own request isolation
  it("stops counting once the wrapped function returns", async () => {
    await withSpendMeter(7, async () => {});
    await call();
    expect(inserts()).toHaveLength(0);
  });

  // protects: counting never breaks a capture; fails_when: a failed insert throws out of callLlm; no_claim: none
  it("still returns the answer when the insert fails", async () => {
    failInsert = true;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(withSpendMeter(7, () => call())).resolves.toBe("ok");
    err.mockRestore();
  });
});

describe("monthSpend", () => {
  beforeEach(() => { queries.length = 0; });

  // protects: Settings' "this month" line; fails_when: counts or cost are dropped or the month isn't the window; no_claim: none
  it("sums this month's calls, tokens and estimated cost", async () => {
    monthRows = [{ calls: "23", tokens_in: "120000", tokens_out: "30000", cost_usd: 0.41, unpriced: "2" }];
    expect(await monthSpend(7)).toEqual({ calls: 23, tokensIn: 120000, tokensOut: 30000, costUsd: 0.41, unpricedCalls: 2 });
    const select = queries.find((q) => q.text.startsWith("SELECT"))!;
    expect(select.text).toContain("date_trunc('month'");
    expect(select.values).toContain(7);
  });

  // protects: an empty month reads as zero; fails_when: nulls reach the page; no_claim: none
  it("reads an empty month as zero", async () => {
    monthRows = [{ calls: "0", tokens_in: null, tokens_out: null, cost_usd: null, unpriced: "0" }];
    expect(await monthSpend(7)).toEqual({ calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, unpricedCalls: 0 });
  });
});
