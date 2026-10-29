import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

/**
 * handoff_events: what happened to each handoff (queued now; offered and the
 * user's answers later). Like apply_events it keeps a keyed hash of the
 * capture, never its name; HANDOFFS.md stays the record.
 */

const queries: Array<{ text: string; values: unknown[] }> = [];
let fail = false;

vi.mock("../sql", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    queries.push({ text, values });
    if (fail && text.startsWith("INSERT")) return Promise.reject(new Error("db down"));
    return Promise.resolve({ rows: [], rowCount: 0 });
  },
}));

beforeAll(() => {
  process.env.SESSION_SECRET = "test-secret-for-handoff-events";
});

const { recordHandoffEvent } = await import("../handoff-events");
const { captureKey } = await import("../apply-events");

beforeEach(() => {
  queries.length = 0;
  fail = false;
});

describe("recordHandoffEvent", () => {
  // protects: the queue's counts never hold a capture's name; fails_when: the filename is stored or the key differs from apply_events'; no_claim: none
  it("stores a keyed hash of the capture, the repo, the event and its source", async () => {
    await recordHandoffEvent(7, "inbox/2026-10-29-llm-memory.md", "acme/app", "queued", { source: "auto" });
    const insert = queries.find((q) => q.text.startsWith("INSERT"))!;
    expect(insert.text).toBe("INSERT INTO handoff_events (user_id, capture_key, repo, event, source, reason, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)");
    expect(insert.values).toEqual([7, captureKey("2026-10-29-llm-memory.md"), "acme/app", "queued", "auto", null, null]);
    expect(JSON.stringify(insert.values)).not.toContain("llm-memory");
  });

  // protects: a fresh database works; fails_when: the insert runs before the table exists; no_claim: none
  it("makes sure the table exists first", async () => {
    vi.resetModules();
    const fresh = await import("../handoff-events");
    await fresh.recordHandoffEvent(7, "inbox/a.md", "acme/app", "queued", { source: "button" });
    const create = queries.findIndex((q) => q.text.startsWith("CREATE TABLE IF NOT EXISTS handoff_events"));
    expect(create).toBeGreaterThanOrEqual(0);
    expect(create).toBeLessThan(queries.findIndex((q) => q.text.startsWith("INSERT")));
  });

  // protects: a capture or a button click never fails on the count; fails_when: a failed insert throws; no_claim: none
  it("never throws", async () => {
    fail = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(recordHandoffEvent(7, "inbox/a.md", "acme/app", "queued", { source: "auto" })).resolves.toBeUndefined();
    spy.mockRestore();
  });
});
