import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

/**
 * Machine keys from browser sign-in (cli_keys) work wherever the account key
 * does, because every key check goes through getUserByApiKey. Rotating the
 * key or deleting the account removes them.
 */

const queries: Array<{ text: string; values: unknown[] }> = [];
let results: Array<{ rows: unknown[] }> = [];

vi.mock("../sql", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join("?").replace(/\s+/g, " ").trim(), values });
    const next = /^(CREATE|ALTER)/.test(queries.at(-1)!.text) ? { rows: [] } : (results.shift() ?? { rows: [] });
    return Promise.resolve({ rows: next.rows, rowCount: next.rows.length });
  },
}));

beforeAll(() => {
  process.env.SESSION_SECRET = "test-secret-for-cli-keys";
});

const { getUserByApiKey, deleteCliKeys, deleteUserData } = await import("../db");
const { hashApiKey } = await import("../crypto");

const user = { id: 7, github_token: "", llm_api_key: null };

beforeEach(() => {
  queries.length = 0;
  results = [];
});

describe("getUserByApiKey with machine keys", () => {
  it("finds the user of a machine key when no account key matches, and notes its use", async () => {
    // account key (hashed), legacy plaintext, then cli_keys
    results = [{ rows: [] }, { rows: [] }, { rows: [user] }];
    const found = await getUserByApiKey("xkg_machine");
    expect(found?.id).toBe(7);
    const lookup = queries.find((q) => q.text.includes("FROM cli_keys"))!;
    expect(lookup.text).toContain("JOIN users");
    expect(lookup.values).toEqual([hashApiKey("xkg_machine")]);
    expect(queries.some((q) => /^UPDATE cli_keys SET last_used_at = NOW\(\)/.test(q.text))).toBe(true);
  });

  it("returns null when no key of any kind matches", async () => {
    results = [{ rows: [] }, { rows: [] }, { rows: [] }];
    expect(await getUserByApiKey("xkg_nope")).toBeNull();
  });

  it("doesn't look at machine keys when the account key matches", async () => {
    results = [{ rows: [user] }];
    expect((await getUserByApiKey("xkg_account"))?.id).toBe(7);
    expect(queries.some((q) => q.text.includes("cli_keys") && !/^CREATE/.test(q.text))).toBe(false);
  });
});

describe("removing machine keys", () => {
  it("deletes every machine key of a user", async () => {
    await deleteCliKeys(7);
    const del = queries.find((q) => q.text.startsWith("DELETE FROM cli_keys"))!;
    expect(del.text).toBe("DELETE FROM cli_keys WHERE user_id = ?");
    expect(del.values).toEqual([7]);
  });

  it("account deletion removes them before the users row", async () => {
    await deleteUserData(7, "octo");
    const deletes = queries.filter((q) => q.text.startsWith("DELETE")).map((q) => q.text);
    expect(deletes).toContain("DELETE FROM cli_keys WHERE user_id = ?");
    expect(deletes).toContain("DELETE FROM cli_logins WHERE user_id = ?");
    expect(deletes.at(-1)).toBe("DELETE FROM users WHERE id = ?");
  });
});
