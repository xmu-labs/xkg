import { describe, it, expect, vi, beforeEach } from "vitest";

const { neon, query } = vi.hoisted(() => {
  const query = vi.fn();
  return { query, neon: vi.fn(() => query) };
});
vi.mock("@neondatabase/serverless", () => ({ neon }));

describe("sql", () => {
  beforeEach(() => {
    vi.resetModules();
    neon.mockClear();
    query.mockReset();
    process.env.POSTGRES_URL = "postgres://user:pass@db.example/app";
  });

  it("returns rows and rowCount in the shape @vercel/postgres did", async () => {
    query.mockResolvedValue({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 });
    const { sql } = await import("../sql");
    const { rows, rowCount } = await sql<{ id: number }>`SELECT id FROM users`;
    expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(rowCount).toBe(2);
  });

  it("passes values as query parameters, never in the SQL text", async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    const { sql } = await import("../sql");
    const name = "x'; DROP TABLE users; --";
    await sql`SELECT * FROM users WHERE github_username = ${name}`;
    const [strings, ...values] = query.mock.calls[0]!;
    expect(strings).toEqual(["SELECT * FROM users WHERE github_username = ", ""]);
    expect(values).toEqual([name]);
  });

  it("connects once, on first use, with full results from POSTGRES_URL", async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    const { sql } = await import("../sql");
    expect(neon).not.toHaveBeenCalled();
    await sql`SELECT 1`;
    await sql`SELECT 2`;
    expect(neon).toHaveBeenCalledTimes(1);
    expect(neon).toHaveBeenCalledWith("postgres://user:pass@db.example/app", { fullResults: true });
  });

  it("falls back to the row count when the driver reports none", async () => {
    query.mockResolvedValue({ rows: [{ a: 1 }], rowCount: null });
    const { sql } = await import("../sql");
    expect((await sql`SELECT 1 AS a`).rowCount).toBe(1);
  });

  it("names the missing variable instead of failing inside the driver", async () => {
    delete process.env.POSTGRES_URL;
    const { sql } = await import("../sql");
    await expect(sql`SELECT 1`).rejects.toThrow("POSTGRES_URL");
    expect(neon).not.toHaveBeenCalled();
  });
});
