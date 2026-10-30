import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

/**
 * handoff_events: what happened to each handoff (queued now; offered and the
 * user's answers later). Like apply_events it keeps a keyed hash of the
 * capture, never its name; HANDOFFS.md stays the record.
 */

const queries: Array<{ text: string; values: unknown[] }> = [];
let fail = false;
let rows: unknown[] = [];

vi.mock("../sql", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    queries.push({ text, values });
    if (fail && /^(INSERT|SELECT)/.test(text)) return Promise.reject(new Error("db down"));
    return Promise.resolve({ rows, rowCount: rows.length });
  },
}));

beforeAll(() => {
  process.env.SESSION_SECRET = "test-secret-for-handoff-events";
});

const { recordHandoffEvent, recordOffers, offerDays, handoffStats } = await import("../handoff-events");
const { captureKey } = await import("../apply-events");

beforeEach(() => {
  queries.length = 0;
  fail = false;
  rows = [];
});

describe("recordHandoffEvent", () => {
  // protects: the queue's counts never hold a capture's name; fails_when: the filename is stored or the key differs from apply_events'; no_claim: none
  it("stores a keyed hash of the capture, the repo, the event and its source", async () => {
    await recordHandoffEvent(7, "inbox/2026-10-29-llm-memory.md", "acme/app", "queued", { source: "auto" });
    const insert = queries.find((q) => q.text.startsWith("INSERT"))!;
    expect(insert.text).toBe("INSERT INTO handoff_events (user_id, capture_key, repo, event, source, reason, confidence, with_commit) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    expect(insert.values).toEqual([7, captureKey("2026-10-29-llm-memory.md"), "acme/app", "queued", "auto", null, null, null]);
    expect(JSON.stringify(insert.values)).not.toContain("llm-memory");
  });

  // protects: answers keep their reason and confidence, and an apply says whether it came with a commit; fails_when: either is dropped; no_claim: none
  it("stores an answer's reason, confidence and commit flag", async () => {
    await recordHandoffEvent(7, "inbox/a.md", "acme/app", "declined", { reason: "wrong-files", confidence: "low" });
    await recordHandoffEvent(7, "inbox/a.md", "acme/app", "applied", { withCommit: true });
    const inserts = queries.filter((q) => q.text.startsWith("INSERT"));
    expect(inserts.map((q) => q.values.slice(3))).toEqual([
      ["declined", null, "wrong-files", "low", null],
      ["applied", null, null, null, true],
    ]);
  });

  // protects: a fresh database works, and one made before the commit flag gets it; fails_when: the insert runs before the table or the column exists; no_claim: none
  it("makes sure the table and its columns exist first", async () => {
    vi.resetModules();
    const fresh = await import("../handoff-events");
    await fresh.recordHandoffEvent(7, "inbox/a.md", "acme/app", "queued", { source: "button" });
    const create = queries.findIndex((q) => q.text.startsWith("CREATE TABLE IF NOT EXISTS handoff_events"));
    const alter = queries.findIndex((q) => q.text === "ALTER TABLE handoff_events ADD COLUMN IF NOT EXISTS with_commit BOOLEAN");
    expect(create).toBeGreaterThanOrEqual(0);
    expect(alter).toBeGreaterThan(create);
    expect(alter).toBeLessThan(queries.findIndex((q) => q.text.startsWith("INSERT")));
  });

  // protects: a capture or a button click never fails on the count; fails_when: a failed insert throws; no_claim: none
  it("never throws", async () => {
    fail = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(recordHandoffEvent(7, "inbox/a.md", "acme/app", "queued", { source: "auto" })).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

describe("offers", () => {
  // protects: AC8 counts offers per capture without storing names; fails_when: one row per capture isn't written or a name is stored; no_claim: none
  it("records one offered row per capture, keyed", async () => {
    await recordOffers(7, "acme/app", ["inbox/a.md", "applied/b.md"]);
    const insert = queries.find((q) => q.text.startsWith("INSERT"))!;
    expect(insert.text).toBe("INSERT INTO handoff_events (user_id, capture_key, repo, event) SELECT ?, k, ?, 'offered' FROM unnest(?::text[]) AS k");
    expect(insert.values).toEqual([7, "acme/app", [captureKey("a.md"), captureKey("b.md")]]);
  });

  // protects: expiry reads back the days each capture was offered in this repo; fails_when: days come back under the wrong capture or repo; no_claim: none
  it("reads the days each capture was offered, by name", async () => {
    rows = [
      { capture_key: captureKey("a.md"), day: "2026-10-21" },
      { capture_key: captureKey("a.md"), day: "2026-10-22" },
      { capture_key: captureKey("b.md"), day: "2026-10-22" },
    ];
    const days = await offerDays(7, "acme/app", ["inbox/a.md", "inbox/b.md", "inbox/c.md"]);
    expect(days).toEqual(new Map([["a.md", ["2026-10-21", "2026-10-22"]], ["b.md", ["2026-10-22"]]]));
    const select = queries.find((q) => q.text.startsWith("SELECT"))!;
    expect(select.values).toEqual([7, "acme/app", [captureKey("a.md"), captureKey("b.md"), captureKey("c.md")]]);
  });

  // protects: a briefing never fails on the counts; fails_when: a failed read throws; no_claim: none
  it("reads no days when the database fails", async () => {
    fail = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(offerDays(7, "acme/app", ["inbox/a.md"])).resolves.toEqual(new Map());
    await expect(recordOffers(7, "acme/app", ["inbox/a.md"])).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

describe("handoffStats", () => {
  // protects: Q3's weekly numbers, per user: what was queued and offered, and every answer; fails_when: an event lands in the wrong week, user or bucket; no_claim: what the admin route does with them
  it("counts each event per user and week", async () => {
    rows = [
      { user_id: 7, event: "queued", source: "auto", reason: null, with_commit: null, at: "2026-10-26T10:00:00Z" },
      { user_id: 7, event: "queued", source: "button", reason: null, with_commit: null, at: "2026-10-27T10:00:00Z" },
      { user_id: 7, event: "offered", source: null, reason: null, with_commit: null, at: "2026-10-27T10:00:00Z" },
      { user_id: 7, event: "offered", source: null, reason: null, with_commit: null, at: "2026-10-28T10:00:00Z" },
      { user_id: 7, event: "applied", source: null, reason: null, with_commit: true, at: "2026-10-28T11:00:00Z" },
      { user_id: 7, event: "applied", source: null, reason: null, with_commit: false, at: "2026-10-28T12:00:00Z" },
      { user_id: 7, event: "declined", source: null, reason: "wrong-files", with_commit: null, at: "2026-10-29T10:00:00Z" },
      { user_id: 7, event: "declined", source: null, reason: "doesnt-fit", with_commit: null, at: "2026-10-29T10:00:00Z" },
      { user_id: 7, event: "declined", source: null, reason: null, with_commit: null, at: "2026-10-29T10:00:00Z" },
      { user_id: 7, event: "done", source: null, reason: null, with_commit: null, at: "2026-10-29T10:00:00Z" },
      { user_id: 7, event: "later", source: null, reason: null, with_commit: null, at: "2026-10-29T10:00:00Z" },
      { user_id: 7, event: "expired", source: null, reason: null, with_commit: null, at: "2026-10-29T10:00:00Z" },
      { user_id: 7, event: "reverted", source: null, reason: null, with_commit: null, at: "2026-10-30T10:00:00Z" },
      { user_id: 7, event: "offered", source: null, reason: null, with_commit: null, at: "2026-10-20T10:00:00Z" },
      { user_id: 9, event: "offered", source: null, reason: null, with_commit: null, at: "2026-10-27T10:00:00Z" },
    ];
    const zero = { queued: { auto: 0, button: 0 }, offered: 0, applied: 0, appliedWithCommit: 0, declined: { wrongFiles: 0, doesntFit: 0, other: 0 }, done: 0, later: 0, expired: 0, reverted: 0 };
    expect(await handoffStats("2026-10-30", 2)).toEqual([
      {
        userId: 7, weekStart: "2026-10-26",
        counts: { queued: { auto: 1, button: 1 }, offered: 2, applied: 2, appliedWithCommit: 1, declined: { wrongFiles: 1, doesntFit: 1, other: 1 }, done: 1, later: 1, expired: 1, reverted: 1 },
      },
      { userId: 7, weekStart: "2026-10-19", counts: { ...zero, offered: 1 } },
      { userId: 9, weekStart: "2026-10-26", counts: { ...zero, offered: 1 } },
    ]);
    const select = queries.find((q) => q.text.startsWith("SELECT"))!;
    expect(select.values).toEqual(["2026-10-19"]);
  });
});
