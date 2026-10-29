import { describe, it, expect, vi, beforeEach } from "vitest";

/** How a code map is stored: one row per user and repo, at most 20 repos per user. */

const queries: Array<{ text: string; values: unknown[] }> = [];

vi.mock("../sql", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join("?").replace(/\s+/g, " ").trim(), values });
    const rows = nextRows;
    nextRows = [];
    return Promise.resolve({ rows, rowCount: rows.length });
  },
}));

let nextRows: unknown[] = [];
const { saveCodeMap, initDb, listCodeMaps, listCodeRepos, deleteCodeMap } = await import("../db");

beforeEach(() => {
  queries.length = 0;
});

const map = { repo: "acme/widgets", head7: "abc1234", truncated: false, files: [{ p: "a.ts", e: ["a"] }] };

describe("saveCodeMap", () => {
  // protects: one row per user and repo, newest wins; fails_when: a resync adds a second row or keeps the old map; no_claim: Postgres behavior itself
  it("creates the table on first use, then upserts the repo's row", async () => {
    await saveCodeMap(7, map, "h".repeat(64));
    expect(queries[0]!.text).toMatch(/^CREATE TABLE IF NOT EXISTS code_maps \(/);
    expect(queries.map((q) => q.text)).toContain("CREATE UNIQUE INDEX IF NOT EXISTS code_maps_user_repo ON code_maps (user_id, repo)");
    const upsert = queries.find((q) => q.text.startsWith("INSERT INTO code_maps"))!;
    expect(upsert.text).toContain("ON CONFLICT (user_id, repo) DO UPDATE SET");
    expect(upsert.values).toEqual([7, "acme/widgets", JSON.stringify(map.files), "h".repeat(64), "abc1234", 1, false, "local"]);
  });

  // protects: AC4 and precedence, a map from the user's machine always wins; fails_when: a GitHub fetch overwrites a local map, or a local sync can't replace a GitHub one; no_claim: Postgres conflict handling itself
  it("lets a local sync replace any row, and a GitHub fetch replace only a GitHub row", async () => {
    nextRows = [{ id: 1 }];
    expect(await saveCodeMap(7, map, "h", "github")).toBe(true);
    const upsert = queries.find((q) => q.text.startsWith("INSERT INTO code_maps"))!;
    expect(upsert.values.at(-1)).toBe("github");
    expect(upsert.text).toContain("source = EXCLUDED.source");
    expect(upsert.text).toMatch(/WHERE EXCLUDED\.source = 'local' OR code_maps\.source = 'github' RETURNING id$/);
    queries.length = 0;
    nextRows = [];
    expect(await saveCodeMap(7, map, "h", "github")).toBe(false);
    expect(queries.some((q) => q.text.startsWith("DELETE FROM code_maps"))).toBe(false);
  });

  // protects: the 20-repo cap; fails_when: a 21st repo is kept alongside the other 20, or another user's rows are touched; no_claim: ordering ties
  it("then keeps only the user's 20 most recently synced repos", async () => {
    nextRows = [{ id: 1 }];
    await saveCodeMap(7, map, "h");
    const evict = queries.find((q) => q.text.startsWith("DELETE FROM code_maps"))!;
    expect(evict.text).toBe("DELETE FROM code_maps WHERE user_id = ? AND id NOT IN ( SELECT id FROM code_maps WHERE user_id = ? ORDER BY synced_at DESC, id DESC LIMIT ? )");
    expect(evict.values).toEqual([7, 7, 20]);
  });
});

describe("initDb", () => {
  it("creates the code_maps table too", async () => {
    await initDb();
    expect(queries.some((q) => q.text.startsWith("CREATE TABLE IF NOT EXISTS code_maps"))).toBe(true);
  });
});

describe("listCodeMaps", () => {
  // protects: matching reads only this user's most recent maps; fails_when: another user's maps or more than the limit are read; no_claim: Postgres ordering itself
  it("reads the user's most recently synced maps, newest first", async () => {
    await listCodeMaps(7, 1); // creates the table first
    queries.length = 0;
    const syncedAt = new Date("2026-10-29T10:00:00Z");
    nextRows = [{ repo: "acme/widgets", map: [{ p: "a.ts", e: ["a"] }], head7: "abc1234", truncated: false, source: "local", synced_at: syncedAt }];
    const maps = await listCodeMaps(7, 5);
    expect(queries[0]!.text).toBe("SELECT repo, map, head7, truncated, source, synced_at FROM code_maps WHERE user_id = ? ORDER BY synced_at DESC, id DESC LIMIT ?");
    expect(queries[0]!.values).toEqual([7, 5]);
    expect(maps).toEqual([{ repo: "acme/widgets", files: [{ p: "a.ts", e: ["a"] }], head7: "abc1234", truncated: false, source: "local", syncedAt }]);
  });
});

describe("listCodeRepos", () => {
  // protects: Settings lists this user's repos without loading their maps; fails_when: another user's rows or the map itself are read; no_claim: none
  it("lists the user's repos with their source, size and sync time, newest first, without the maps", async () => {
    await listCodeRepos(7);
    queries.length = 0;
    const syncedAt = new Date("2026-10-29T10:00:00Z");
    nextRows = [{ repo: "acme/widgets", source: "github", file_count: 12, truncated: false, synced_at: syncedAt }];
    expect(await listCodeRepos(7)).toEqual([{ repo: "acme/widgets", source: "github", files: 12, truncated: false, syncedAt }]);
    expect(queries[0]!.text).toBe("SELECT repo, source, file_count, truncated, synced_at FROM code_maps WHERE user_id = ? ORDER BY synced_at DESC, id DESC");
    expect(queries[0]!.values).toEqual([7]);
  });
});

describe("deleteCodeMap", () => {
  // protects: AC3, removing a repo deletes only that user's row; fails_when: another user's row or another repo is deleted; no_claim: none
  it("deletes one repo of one user and says whether it was there", async () => {
    await deleteCodeMap(7, "acme/widgets");
    queries.length = 0;
    nextRows = [{ id: 3 }];
    expect(await deleteCodeMap(7, "acme/widgets")).toBe(true);
    expect(queries[0]!.text).toBe("DELETE FROM code_maps WHERE user_id = ? AND repo = ? RETURNING id");
    expect(queries[0]!.values).toEqual([7, "acme/widgets"]);
    expect(await deleteCodeMap(7, "acme/other")).toBe(false);
  });
});
