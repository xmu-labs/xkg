import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";

/**
 * upgradeLegacyData brings rows from before credential protection up to what
 * the Privacy Policy says. The SQL is checked as issued against a legacy row
 * and an already-protected one.
 */

process.env.SESSION_SECRET = "test-session-secret-for-credential-encryption";

const queries: Array<{ text: string; values: unknown[] }> = [];
let userRows: Array<Record<string, unknown>> = [];

vi.mock("../sql", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    queries.push({ text, values });
    const rows = text.startsWith("SELECT id, github_token") ? userRows : [];
    return Promise.resolve({ rows, rowCount: rows.length });
  },
}));

const { upgradeLegacyData } = await import("../db");
const { decrypt, hashApiKey, encrypt } = await import("../crypto");
const { verifyPin, hashPin } = await import("../pin");

const legacyPin = crypto.createHash("sha256").update("482913").digest("hex");

beforeEach(() => {
  queries.length = 0;
});

describe("upgradeLegacyData", () => {
  it("protects every legacy credential, each update conditional on the old value", async () => {
    userRows = [{
      id: 7,
      github_token: "gho_plain",
      llm_api_key: "sk-plain",
      api_key: "xkg_plainkey",
      pin_hash: legacyPin,
    }];
    await upgradeLegacyData();

    const updates = queries.filter((q) => q.text.startsWith("UPDATE users"));
    expect(updates.map((q) => q.text)).toEqual([
      "UPDATE users SET github_token = ? WHERE id = ? AND github_token = ?",
      "UPDATE users SET llm_api_key = ? WHERE id = ? AND llm_api_key = ?",
      "UPDATE users SET api_key = ? WHERE id = ? AND api_key = ?",
      "UPDATE users SET pin_hash = ? WHERE id = ? AND pin_hash = ?",
    ]);

    const [token, llm, api, pin] = updates.map((q) => q.values);
    expect(decrypt(token![0] as string)).toBe("gho_plain");
    expect(token!.slice(1)).toEqual([7, "gho_plain"]);
    expect(decrypt(llm![0] as string)).toBe("sk-plain");
    expect(llm!.slice(1)).toEqual([7, "sk-plain"]);
    expect(api![0]).toBe(hashApiKey("xkg_plainkey"));
    expect(api!.slice(1)).toEqual([7, "xkg_plainkey"]);
    expect(verifyPin("482913", pin![0] as string)).toBe(true);
    expect(pin!.slice(1)).toEqual([7, legacyPin]);
  });

  it("leaves already-protected and empty values alone", async () => {
    userRows = [
      {
        id: 8,
        github_token: encrypt("gho_new"),
        llm_api_key: encrypt("sk-new"),
        api_key: hashApiKey("xkg_newkey"),
        pin_hash: hashPin("482913"),
      },
      { id: 9, github_token: encrypt("gho_x"), llm_api_key: null, api_key: null, pin_hash: null },
    ];
    await upgradeLegacyData();
    expect(queries.filter((q) => q.text.startsWith("UPDATE"))).toEqual([]);
  });

  it("deletes PIN lockout rows still keyed by username", async () => {
    userRows = [];
    await upgradeLegacyData();
    expect(queries.at(-1)?.text).toBe("DELETE FROM login_attempts WHERE identifier NOT LIKE 'user:%'");
  });
});
