import { describe, it, expect, vi } from "vitest";

/** The apply_events table and the unique index that makes a repeated report count once. */

const queries: string[] = [];

vi.mock("../sql", () => ({
  sql: (strings: TemplateStringsArray) => {
    queries.push(strings.join("?").replace(/\s+/g, " ").trim());
    return Promise.resolve({ rows: [], rowCount: 0 });
  },
}));

const { initDb } = await import("../db");

describe("initDb", () => {
  it("creates apply_events with no column for the capture name or reason", async () => {
    await initDb();
    const create = queries.find((q) => q.startsWith("CREATE TABLE IF NOT EXISTS apply_events"));
    expect(create).toBeDefined();
    expect(create).toContain("capture_key TEXT NOT NULL");
    expect(create).not.toMatch(/filename|note|why TEXT/);
  });

  it("counts one capture and commit once per user", async () => {
    await initDb();
    expect(queries).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS apply_events_once ON apply_events (user_id, capture_key, commit7)",
    );
  });
});
