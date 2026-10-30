import { describe, it, expect, beforeEach } from "vitest";
import { browserSignIn, type SignInDeps } from "../sign-in.js";

/**
 * Browser sign-in from the CLI: ask the server for a code, open the approve
 * page, poll until the user approves (key), denies or the code expires.
 * The server is a scripted fetch; sleeping is recorded, not waited.
 */

let calls: Array<{ url: string; body: unknown }>;
let polls: Array<Record<string, unknown> | Error>;
let slept: number[];
let opened: string[];
let out: string[];

const START = {
  device_code: "dc",
  user_code: "BCDF-GHJK",
  verification_uri: "https://xkg.xmu.sh/api/cli-login/approve",
  verification_uri_complete: "https://xkg.xmu.sh/api/cli-login/approve?code=BCDF-GHJK",
  expires_in: 600,
  interval: 5,
};

function deps(over: Partial<SignInDeps> = {}): SignInDeps {
  return {
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/start")) return new Response(JSON.stringify(START), { status: 200 });
      const next = polls.shift() ?? { status: "expired" };
      if (next instanceof Error) throw next;
      return new Response(JSON.stringify(next), { status: 200 });
    }) as typeof fetch,
    open: (url) => opened.push(url),
    sleep: async (ms) => {
      slept.push(ms);
    },
    log: (line) => out.push(line),
    label: "sophs-mac",
    ...over,
  };
}

beforeEach(() => {
  calls = [];
  polls = [];
  slept = [];
  opened = [];
  out = [];
});

describe("browserSignIn", () => {
  it("starts with the machine name, shows the code, opens the page and returns the key once approved", async () => {
    polls = [{ status: "pending" }, { status: "approved", api_key: "xkg_m" }];
    const res = await browserSignIn(deps());
    expect(res).toEqual({ ok: true, key: "xkg_m" });
    expect(calls[0]).toEqual({ url: "https://xkg.xmu.sh/api/cli-login/start", body: { label: "sophs-mac" } });
    expect(calls.slice(1).every((c) => c.url === "https://xkg.xmu.sh/api/cli-login/poll" && (c.body as { device_code: string }).device_code === "dc")).toBe(true);
    expect(opened).toEqual([START.verification_uri_complete]);
    expect(out.join("\n")).toContain("BCDF-GHJK");
    expect(out.join("\n")).toContain(START.verification_uri_complete);
    expect(slept).toEqual([5000, 5000]);
  });

  it("waits five seconds longer each time the server says slow down", async () => {
    polls = [{ status: "slow_down" }, { status: "slow_down" }, { status: "approved", api_key: "k" }];
    await browserSignIn(deps());
    expect(slept).toEqual([5000, 10000, 15000]);
  });

  it("stops when the user denies", async () => {
    polls = [{ status: "denied" }];
    const res = await browserSignIn(deps());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/denied/i);
  });

  it("stops when the code expires", async () => {
    polls = [{ status: "expired" }];
    const res = await browserSignIn(deps());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/expired/i);
  });

  it("keeps polling through a dropped connection, but gives up when the code would have expired", async () => {
    polls = [new Error("ECONNRESET"), { status: "approved", api_key: "k" }];
    expect(await browserSignIn(deps())).toEqual({ ok: true, key: "k" });

    polls = Array.from({ length: 500 }, () => new Error("offline"));
    slept = [];
    const res = await browserSignIn(deps());
    expect(res.ok).toBe(false);
    expect(slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(600_000);
  });

  it("still works when the browser can't be opened", async () => {
    polls = [{ status: "approved", api_key: "k" }];
    const res = await browserSignIn(deps({ open: () => { throw new Error("no browser"); } }));
    expect(res).toEqual({ ok: true, key: "k" });
  });

  it("says why when the server won't start a sign-in", async () => {
    const res = await browserSignIn(deps({ fetch: (async () => new Response(JSON.stringify({ error: "Too many sign-in attempts. Try again later." }), { status: 429 })) as typeof fetch }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/too many/i);
  });
});
