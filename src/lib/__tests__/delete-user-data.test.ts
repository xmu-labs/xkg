import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * What account deletion removes, and what it tells GitHub. The SQL is checked
 * as issued: every table keyed to the user is cleared, and the users row goes
 * last so a failure part-way leaves an account the user can retry from.
 */

const queries: Array<{ text: string; values: unknown[] }> = [];

vi.mock("../sql", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join("?").replace(/\s+/g, " ").trim(), values });
    return Promise.resolve({ rows: [], rowCount: 0 });
  },
}));

const { deleteUserData } = await import("../db");
const { revokeGithubGrant } = await import("../github");

beforeEach(() => {
  queries.length = 0;
});

describe("deleteUserData", () => {
  it("clears every table keyed to the user, users row last", async () => {
    await deleteUserData(7, "Octo-Cat");

    expect(queries.map((q) => q.text)).toEqual([
      "DELETE FROM oauth_refresh_tokens WHERE user_id = ?",
      "DELETE FROM oauth_codes WHERE user_id = ?",
      "DELETE FROM usage_quota WHERE identifier = ?",
      "DELETE FROM login_attempts WHERE identifier IN (?, ?)",
      "DELETE FROM apply_events WHERE user_id = ?",
      "DELETE FROM users WHERE id = ?",
    ]);
    expect(queries.map((q) => q.values)).toEqual([
      [7],
      [7],
      ["capture:user:7"],
      ["user:7", "octo-cat"],
      [7],
      [7],
    ]);
  });
});

describe("revokeGithubGrant", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("deletes the app's grant, authenticated as the app", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(revokeGithubGrant("cid", "secret", "gho_token")).resolves.toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/applications/cid/grant");
    expect(init.method).toBe("DELETE");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("cid:secret").toString("base64")}`);
    expect(JSON.parse(init.body as string)).toEqual({ access_token: "gho_token" });
  });

  it("gives up on a GitHub that doesn't answer, instead of hanging the deletion", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await revokeGithubGrant("cid", "secret", "gho_token");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("only a 204 confirms revocation", async () => {
    // A 404 can mean the stored token is stale while another token for the grant still works.
    for (const status of [404, 422, 500]) {
      fetchMock.mockResolvedValueOnce(new Response("{}", { status }));
      await expect(revokeGithubGrant("cid", "secret", "gho_token")).resolves.toBe(false);
    }
  });
});
