import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

/**
 * Browser sign-in for the CLI (a device flow, RFC 8628 in shape): the CLI
 * starts a login, the user approves it in the browser, and the CLI picks up a
 * key for this machine once. Each machine gets its own key in cli_keys, so
 * signing in on a new machine never cuts off another one.
 */

const queries: Array<{ text: string; values: unknown[] }> = [];
let results: Array<{ rows: unknown[] }> = [];

vi.mock("../sql", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join("?").replace(/\s+/g, " ").trim(), values });
    // Table creation runs once per process and takes no queued result.
    const next = /^(CREATE|ALTER)/.test(queries.at(-1)!.text) ? { rows: [] } : (results.shift() ?? { rows: [] });
    return Promise.resolve({ rows: next.rows, rowCount: next.rows.length });
  },
}));

beforeAll(() => {
  process.env.SESSION_SECRET = "test-secret-for-cli-login";
});

const { newUserCode, normalizeUserCode, pollStatus, createCliLogin, pollCliLogin, approveCliLogin, denyCliLogin, getPendingCliLogin, POLL_INTERVAL_SECONDS } =
  await import("../cli-login");
const { encrypt, hashApiKey } = await import("../crypto");

const ran = (pattern: RegExp) => queries.filter((q) => pattern.test(q.text));

beforeEach(() => {
  queries.length = 0;
  results = [];
});

describe("user codes", () => {
  it("are eight letters without vowels, split by a dash", () => {
    for (let i = 0; i < 50; i++) expect(newUserCode()).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
  });

  it("are read the way people type them", () => {
    expect(normalizeUserCode("bcdf-ghjk")).toBe("BCDF-GHJK");
    expect(normalizeUserCode(" bcdfghjk ")).toBe("BCDF-GHJK");
    expect(normalizeUserCode("BCDF GHJK")).toBe("BCDF-GHJK");
  });

  it("reject anything that can't be a code", () => {
    expect(normalizeUserCode("BCDF-GHJ")).toBeNull();
    expect(normalizeUserCode("ABCD-EFGH")).toBeNull();
    expect(normalizeUserCode("")).toBeNull();
  });
});

describe("pollStatus", () => {
  const now = new Date("2026-10-30T12:00:00Z");
  const row = (over: Record<string, unknown> = {}) => ({
    status: "pending",
    expires_at: new Date("2026-10-30T12:05:00Z"),
    last_poll_at: null,
    ...over,
  });

  it("is pending while waiting for the user", () => {
    expect(pollStatus(row() as never, now)).toBe("pending");
  });

  it("asks a CLI that polls faster than the interval to slow down", () => {
    expect(pollStatus(row({ last_poll_at: new Date(now.getTime() - 1000) }) as never, now)).toBe("slow_down");
    expect(pollStatus(row({ last_poll_at: new Date(now.getTime() - POLL_INTERVAL_SECONDS * 1000) }) as never, now)).toBe("pending");
  });

  it("is expired after ten minutes, even if approved", () => {
    expect(pollStatus(row({ expires_at: new Date(now.getTime() - 1) }) as never, now)).toBe("expired");
    expect(pollStatus(row({ status: "approved", expires_at: new Date(now.getTime() - 1) }) as never, now)).toBe("expired");
  });

  it("reports approval and denial", () => {
    expect(pollStatus(row({ status: "approved" }) as never, now)).toBe("approved");
    expect(pollStatus(row({ status: "denied" }) as never, now)).toBe("denied");
  });
});

describe("createCliLogin", () => {
  it("stores only a hash of the device code, with the machine name and a ten-minute expiry", async () => {
    const before = Date.now();
    const login = await createCliLogin("sophs-mac");
    expect(login.deviceCode).toMatch(/^[a-f0-9]{64}$/);
    expect(login.userCode).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    expect(login.expiresIn).toBe(600);

    const insert = ran(/^INSERT INTO cli_logins/)[0]!;
    expect(insert.values).toContain(hashApiKey(login.deviceCode));
    expect(insert.values).not.toContain(login.deviceCode);
    expect(insert.values).toContain(login.userCode);
    expect(insert.values).toContain("sophs-mac");
    const expires = insert.values.find((v) => v instanceof Date) as Date;
    expect(expires.getTime()).toBeGreaterThanOrEqual(before + 600_000);
  });

  it("trims and caps the machine name", async () => {
    await createCliLogin(`  ${"x".repeat(200)}  `);
    expect(ran(/^INSERT INTO cli_logins/)[0]!.values).toContain("x".repeat(64));
  });

  it("clears logins that expired", async () => {
    await createCliLogin("m");
    expect(ran(/^DELETE FROM cli_logins WHERE expires_at < NOW\(\)/)).toHaveLength(1);
  });
});

describe("pollCliLogin", () => {
  const future = new Date(Date.now() + 300_000);

  it("says expired for an unknown device code", async () => {
    results = [{ rows: [] }];
    expect(await pollCliLogin("nope")).toEqual({ status: "expired" });
  });

  it("records the poll time while pending", async () => {
    results = [{ rows: [{ status: "pending", expires_at: future, last_poll_at: null }] }];
    expect(await pollCliLogin("dc")).toEqual({ status: "pending" });
    expect(ran(/^UPDATE cli_logins SET last_poll_at = NOW\(\)/)).toHaveLength(1);
  });

  it("hands over the key once and deletes the login", async () => {
    results = [
      { rows: [{ status: "approved", expires_at: future, last_poll_at: null }] },
      { rows: [{ api_key: encrypt("xkg_machine") }] },
    ];
    expect(await pollCliLogin("dc")).toEqual({ status: "approved", apiKey: "xkg_machine" });
    const take = ran(/^DELETE FROM cli_logins WHERE device_hash = \? AND status = 'approved'/)[0]!;
    expect(take.values).toEqual([hashApiKey("dc")]);
  });

  it("says expired when the key was already picked up", async () => {
    results = [{ rows: [{ status: "approved", expires_at: future, last_poll_at: null }] }, { rows: [] }];
    expect(await pollCliLogin("dc")).toEqual({ status: "expired" });
  });

  it("deletes a denied login once the CLI has been told", async () => {
    results = [{ rows: [{ status: "denied", expires_at: future, last_poll_at: null }] }];
    expect(await pollCliLogin("dc")).toEqual({ status: "denied" });
    expect(ran(/^DELETE FROM cli_logins WHERE device_hash = \?$/)).toHaveLength(1);
  });
});

describe("approving and denying", () => {
  it("finds a pending login by its code, as typed", async () => {
    results = [{ rows: [{ user_code: "BCDF-GHJK", label: "sophs-mac" }] }];
    expect(await getPendingCliLogin("bcdfghjk")).toEqual({ userCode: "BCDF-GHJK", label: "sophs-mac" });
    expect(ran(/FROM cli_logins WHERE user_code = \? AND status = 'pending' AND expires_at > NOW\(\)/)[0]!.values).toEqual(["BCDF-GHJK"]);
  });

  it("doesn't look up a malformed code", async () => {
    expect(await getPendingCliLogin("zzz")).toBeNull();
    expect(ran(/FROM cli_logins/)).toHaveLength(0);
  });

  it("approves a pending login and adds the machine's key in one statement", async () => {
    results = [{ rows: [{ id: 1 }] }];
    expect(await approveCliLogin("BCDF-GHJK", 7)).toBe(true);
    const q = ran(/^WITH approved AS \(UPDATE cli_logins SET status = 'approved'/)[0]!;
    expect(q.text).toContain("WHERE user_code = ? AND status = 'pending' AND expires_at > NOW()");
    expect(q.text).toContain("INSERT INTO cli_keys (user_id, key_hash, label) SELECT ?, ?, label FROM approved");
    // The key is kept encrypted for pickup and hashed for lookup; never in the clear.
    const enc = q.values.find((v) => typeof v === "string" && v.startsWith("enc:v1:"));
    const hash = q.values.find((v) => typeof v === "string" && v.startsWith("sha256:"));
    expect(enc).toBeTruthy();
    expect(hash).toBeTruthy();
    expect(q.values.some((v) => typeof v === "string" && v.startsWith("xkg_"))).toBe(false);
  });

  it("doesn't approve a login that isn't pending any more", async () => {
    results = [{ rows: [] }];
    expect(await approveCliLogin("BCDF-GHJK", 7)).toBe(false);
  });

  it("denies a pending login", async () => {
    results = [{ rows: [{ user_code: "BCDF-GHJK" }] }];
    expect(await denyCliLogin("BCDF-GHJK")).toBe(true);
    expect(ran(/^UPDATE cli_logins SET status = 'denied' WHERE user_code = \? AND status = 'pending'/)).toHaveLength(1);
  });
});
