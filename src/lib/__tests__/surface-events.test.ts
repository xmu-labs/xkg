import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import type { WhereResult } from "../where";

/**
 * surface_events: which channel showed a capture to the user, so an apply can
 * be split by what surfaced it first (the capture card, a briefing, both,
 * something else, or nothing). Like apply_events it stores a keyed hash of the
 * capture, never its name. A `where` row also keeps the matching call's tokens,
 * the model's own confidence (logged, never shown), the scorer and the tier.
 */

const queries: Array<{ text: string; values: unknown[] }> = [];
let rows: unknown[] = [];
let fail = false;
let failDdl = false;

vi.mock("../sql", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    queries.push({ text, values });
    if (fail && text.startsWith("INSERT")) return Promise.reject(new Error("db down"));
    if (failDdl && text.startsWith("CREATE TABLE")) return Promise.reject(new Error("db down"));
    return Promise.resolve({ rows, rowCount: rows.length });
  },
}));

beforeAll(() => {
  process.env.SESSION_SECRET = "test-secret-for-surface-events";
});

const { recordSurfaceEvents, recordWhereEvent, applySourceStats, matchingStats } = await import("../surface-events");
const { captureKey } = await import("../apply-events");

const inserts = () => queries.filter((q) => q.text.startsWith("INSERT"));
const selects = () => queries.filter((q) => q.text.startsWith("SELECT"));

beforeEach(() => {
  queries.length = 0;
  rows = [];
  fail = false;
  failDdl = false;
});

const where: WhereResult = {
  repo: "acme/app", tier: "strong", files: [{ path: "src/llm.ts" }], also: [], scorer: "evidence", modelConf: 0.94,
  tokens: { in: 3301, out: 142 },
};

describe("recordSurfaceEvents", () => {
  // protects: D6, each capture a channel showed is counted once per call; fails_when: a capture is counted twice or a name is stored; no_claim: none
  it("inserts one row per distinct capture, keyed by the same hash as apply_events", async () => {
    await recordSurfaceEvents(7, ["inbox/2026-01-01-a.md", "applied/2026-01-01-b.md", "inbox/2026-01-01-a.md"], "briefing");
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0]!.text).toMatch(/^INSERT INTO surface_events \(user_id, capture_key, channel\) SELECT \?, k, \? FROM unnest\(\?::text\[\]\) AS k$/);
    expect(inserts()[0]!.values).toEqual([7, "briefing", [captureKey("2026-01-01-a.md"), captureKey("2026-01-01-b.md")]]);
    expect(JSON.stringify(inserts()[0]!.values)).not.toContain("2026-01-01-a");
  });

  it("makes sure the table exists first, so a fresh database works", async () => {
    vi.resetModules();
    const fresh = await import("../surface-events");
    await fresh.recordSurfaceEvents(7, ["inbox/a.md"], "recall");
    expect(queries[0]!.text).toMatch(/^CREATE TABLE IF NOT EXISTS surface_events/);
    expect(queries[0]!.text).toContain("shown BOOLEAN");
    // A table made before the column existed gets it too
    expect(queries.map((q) => q.text)).toContain("ALTER TABLE surface_events ADD COLUMN IF NOT EXISTS shown BOOLEAN");
  });

  // protects: concurrent first uses (the stats route runs two queries at once) share one table creation; fails_when: the DDL runs twice and can collide; no_claim: other processes
  it("creates the table once when two first uses run at the same time", async () => {
    vi.resetModules();
    const fresh = await import("../surface-events");
    await Promise.all([fresh.applySourceStats("2026-10-29", 1), fresh.matchingStats("2026-10-29", 1)]);
    expect(queries.filter((q) => q.text.startsWith("CREATE TABLE"))).toHaveLength(1);
  });

  it("tries to create the table again after a failed attempt", async () => {
    vi.resetModules();
    const fresh = await import("../surface-events");
    failDdl = true;
    await expect(fresh.matchingStats("2026-10-29", 1)).rejects.toThrow("db down");
    failDdl = false;
    await expect(fresh.matchingStats("2026-10-29", 1)).resolves.toEqual([]);
    expect(queries.filter((q) => q.text.startsWith("CREATE TABLE"))).toHaveLength(2);
  });

  it("does nothing for an empty list", async () => {
    await recordSurfaceEvents(7, [], "vault");
    expect(inserts()).toHaveLength(0);
  });

  // protects: logging never breaks a tool; fails_when: a failed insert throws; no_claim: none
  it("never throws when the insert fails", async () => {
    fail = true;
    vi.spyOn(console, "error").mockImplementationOnce(() => {});
    await expect(recordSurfaceEvents(7, ["inbox/a.md"], "briefing")).resolves.toBeUndefined();
  });
});

describe("recordWhereEvent", () => {
  // protects: AC21 and AC22, cost and the model's self-score are logged; fails_when: tokens, model_conf, scorer or tier are missing; no_claim: none
  it("stores the tokens, the model's confidence, the scorer, the tier and whether the user saw it", async () => {
    await recordWhereEvent(7, "inbox/2026-01-01-a.md", where, true);
    expect(inserts()[0]!.text).toMatch(/^INSERT INTO surface_events \(user_id, capture_key, channel, tokens_in, tokens_out, model_conf, scorer, tier, shown\)/);
    expect(inserts()[0]!.text).toContain("VALUES (?, ?, 'where', ?, ?, ?, ?, ?, ?)");
    expect(inserts()[0]!.values).toEqual([7, captureKey("2026-01-01-a.md"), 3301, 142, 0.94, "evidence", "strong", true]);
  });

  it("logs a no-fit match too, since it cost a call", async () => {
    await recordWhereEvent(7, "inbox/a.md", { ...where, tier: "none", files: [], tokens: { in: null, out: null }, modelConf: null }, true);
    expect(inserts()[0]!.values.slice(2)).toEqual([null, null, null, "evidence", "none", true]);
  });

  // protects: a match the user never saw keeps its cost but earns no card credit; fails_when: shown is stored as true for it; no_claim: none
  it("logs a match the user never saw as not shown", async () => {
    await recordWhereEvent(7, "inbox/a.md", where, false);
    expect(inserts()[0]!.values.slice(6)).toEqual(["strong", false]);
  });

  it("logs nothing when no model was called", async () => {
    await recordWhereEvent(7, "inbox/a.md", { ...where, tokens: undefined }, true);
    expect(inserts()).toHaveLength(0);
  });
});

describe("applySourceStats", () => {
  // protects: AC8, applies split by what surfaced them before the apply; fails_when: a capture lands in the wrong bucket or counts twice in a week; no_claim: credit beyond the 5 buckets
  it("puts each applied capture in one bucket per week", async () => {
    const k = (n: string) => captureKey(`2026-01-01-${n}.md`);
    rows = [
      // Shown on the card before one apply and by a briefing before another: both
      { user_id: 7, capture_key: k("a"), applied_at: "2026-10-27T10:00:00Z", card: true, briefing: false, other: false },
      { user_id: 7, capture_key: k("a"), applied_at: "2026-10-28T10:00:00Z", card: false, briefing: true, other: false },
      { user_id: 7, capture_key: k("b"), applied_at: "2026-10-27T10:00:00Z", card: true, briefing: false, other: true },
      { user_id: 7, capture_key: k("c"), applied_at: "2026-10-28T10:00:00Z", card: false, briefing: true, other: true },
      { user_id: 7, capture_key: k("d"), applied_at: "2026-10-29T10:00:00Z", card: false, briefing: false, other: true },
      { user_id: 7, capture_key: k("e"), applied_at: "2026-10-29T10:00:00Z", card: null, briefing: null, other: null },
      { user_id: 7, capture_key: k("f"), applied_at: "2026-10-20T10:00:00Z", card: true, briefing: false, other: false },
    ];
    expect(await applySourceStats("2026-10-29", 2)).toEqual([
      { userId: 7, weekStart: "2026-10-26", sources: { cardOnly: 1, briefingOnly: 1, both: 1, other: 1, none: 1 } },
      { userId: 7, weekStart: "2026-10-19", sources: { cardOnly: 1, briefingOnly: 0, both: 0, other: 0, none: 0 } },
    ]);
  });

  it("only counts surfacing before the apply, and only reads the requested weeks", async () => {
    await applySourceStats("2026-10-29", 2);
    const q = selects()[0]!;
    expect(q.text).toContain("s.surfaced_at <= a.applied_at");
    // Card credit needs a fit the user actually saw
    expect(q.text).toContain("s.channel = 'where' AND s.shown AND s.tier IN ('strong', 'possible')");
    expect(q.text).toMatch(/WHERE a\.applied_at >= \?/);
    expect(q.values).toEqual(["2026-10-19"]);
  });
});

describe("matchingStats", () => {
  // protects: AC21, median tokens per match; fails_when: unknown counts skew the median or no-fit matches go uncounted; no_claim: none
  it("counts matches and suggestions per week, with the median tokens of the calls that reported them", async () => {
    rows = [
      { user_id: 7, tier: "strong", shown: true, tokens_in: 100, tokens_out: 10, surfaced_at: "2026-10-27T10:00:00Z" },
      { user_id: 7, tier: "possible", shown: true, tokens_in: 300, tokens_out: 30, surfaced_at: "2026-10-28T10:00:00Z" },
      { user_id: 7, tier: "none", shown: true, tokens_in: 200, tokens_out: 20, surfaced_at: "2026-10-28T11:00:00Z" },
      { user_id: 7, tier: "none", shown: false, tokens_in: null, tokens_out: null, surfaced_at: "2026-10-29T10:00:00Z" },
      { user_id: 7, tier: "strong", shown: true, tokens_in: 100, tokens_out: 10, surfaced_at: "2026-10-20T10:00:00Z" },
      { user_id: 7, tier: "strong", shown: true, tokens_in: 200, tokens_out: 20, surfaced_at: "2026-10-21T10:00:00Z" },
    ];
    expect(await matchingStats("2026-10-29", 2)).toEqual([
      { userId: 7, weekStart: "2026-10-26", matches: 4, suggestions: 2, medianTokens: 220 },
      { userId: 7, weekStart: "2026-10-19", matches: 2, suggestions: 2, medianTokens: 165 },
    ]);
    expect(selects()[0]!.text).toMatch(/^SELECT user_id, tier, shown, tokens_in, tokens_out, surfaced_at FROM surface_events WHERE channel = 'where' AND surfaced_at >= \?/);
  });

  // protects: a suggestion is a fit the user saw; fails_when: a fit whose section never reached the agent counts as a suggestion; no_claim: none
  it("counts a fit the user never saw as a match but not a suggestion", async () => {
    rows = [{ user_id: 7, tier: "strong", shown: false, tokens_in: 100, tokens_out: 10, surfaced_at: "2026-10-29T10:00:00Z" }];
    expect(await matchingStats("2026-10-29", 1)).toEqual([{ userId: 7, weekStart: "2026-10-26", matches: 1, suggestions: 0, medianTokens: 110 }]);
  });

  it("gives a null median when no call reported tokens", async () => {
    rows = [{ user_id: 7, tier: "none", tokens_in: null, tokens_out: null, surfaced_at: "2026-10-29T10:00:00Z" }];
    expect((await matchingStats("2026-10-29", 1))[0]!.medianTokens).toBeNull();
  });
});
