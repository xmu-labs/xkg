import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * The three routes of browser sign-in: the CLI starts and polls (no session),
 * the browser approves (signed in, same site). Rotating the key in Settings
 * also removes every machine key.
 */

type U = { id: number; github_username: string; github_repo: string | null };
let session: U | null = null;
const lib = {
  createCliLogin: vi.fn(),
  pollCliLogin: vi.fn(),
  getPendingCliLogin: vi.fn(),
  approveCliLogin: vi.fn(),
  denyCliLogin: vi.fn(),
};
const consumeQuota = vi.fn();
const deleteCliKeys = vi.fn();
const updateUserApiKey = vi.fn();

vi.mock("@/lib/session", () => ({ getSession: async () => session, createSession: async () => {} }));
vi.mock("@/lib/cli-login", async (orig) => ({
  ...(await orig<typeof import("@/lib/cli-login")>()),
  createCliLogin: (...a: unknown[]) => lib.createCliLogin(...a),
  pollCliLogin: (...a: unknown[]) => lib.pollCliLogin(...a),
  getPendingCliLogin: (...a: unknown[]) => lib.getPendingCliLogin(...a),
  approveCliLogin: (...a: unknown[]) => lib.approveCliLogin(...a),
  denyCliLogin: (...a: unknown[]) => lib.denyCliLogin(...a),
}));
vi.mock("@/lib/rate-limit", () => ({ consumeQuota: (...a: unknown[]) => consumeQuota(...a) }));
vi.mock("@/lib/db", () => ({
  deleteCliKeys: (...a: unknown[]) => deleteCliKeys(...a),
  updateUserApiKey: (...a: unknown[]) => updateUserApiKey(...a),
  revokeUserTokens: async () => 1,
}));

const start = await import("@/app/api/cli-login/start/route");
const poll = await import("@/app/api/cli-login/poll/route");
const approve = await import("@/app/api/cli-login/approve/route");
const rotate = await import("@/app/api/rotate-key/route");

const ONBOARDED: U = { id: 7, github_username: "octo", github_repo: "octo/xkg-knowledge" };

function json(path: string, body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`https://xkg.xmu.sh${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": "203.0.113.9", ...headers },
    body: JSON.stringify(body),
  });
}

function form(fields: Record<string, string>, headers: Record<string, string> = { "sec-fetch-site": "same-origin" }): NextRequest {
  return new NextRequest("https://xkg.xmu.sh/api/cli-login/approve", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = "https://xkg.xmu.sh";
  session = null;
  for (const f of Object.values(lib)) f.mockReset();
  consumeQuota.mockReset().mockResolvedValue({ allowed: true, used: 1, limit: 20, resetIn: 3600 });
  deleteCliKeys.mockReset();
  updateUserApiKey.mockReset();
});

describe("POST /api/cli-login/start", () => {
  it("returns the codes and where to approve", async () => {
    lib.createCliLogin.mockResolvedValue({ deviceCode: "dc", userCode: "BCDF-GHJK", expiresIn: 600 });
    const res = await start.POST(json("/api/cli-login/start", { label: "sophs-mac" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ device_code: "dc", user_code: "BCDF-GHJK", expires_in: 600, interval: 5 });
    expect(body.verification_uri_complete).toMatch(/\/api\/cli-login\/approve\?code=BCDF-GHJK$/);
    expect(lib.createCliLogin).toHaveBeenCalledWith("sophs-mac");
  });

  it("is rate-limited by address", async () => {
    consumeQuota.mockResolvedValue({ allowed: false, used: 21, limit: 20, resetIn: 99 });
    const res = await start.POST(json("/api/cli-login/start", { label: "m" }));
    expect(res.status).toBe(429);
    expect(consumeQuota.mock.calls[0]![0]).toBe("cli-login:ip:203.0.113.9");
    expect(lib.createCliLogin).not.toHaveBeenCalled();
  });
});

describe("POST /api/cli-login/poll", () => {
  it("passes the status through", async () => {
    lib.pollCliLogin.mockResolvedValue({ status: "pending" });
    const res = await poll.POST(json("/api/cli-login/poll", { device_code: "dc" }));
    expect(await res.json()).toEqual({ status: "pending" });
  });

  it("hands over the key on approval", async () => {
    lib.pollCliLogin.mockResolvedValue({ status: "approved", apiKey: "xkg_m" });
    const res = await poll.POST(json("/api/cli-login/poll", { device_code: "dc" }));
    expect(await res.json()).toEqual({ status: "approved", api_key: "xkg_m" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects a missing device code", async () => {
    const res = await poll.POST(json("/api/cli-login/poll", {}));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/cli-login/approve", () => {
  const get = (code = "BCDF-GHJK") => approve.GET(new NextRequest(`https://xkg.xmu.sh/api/cli-login/approve?code=${code}`));

  it("sends a signed-out browser to GitHub sign-in and back here", async () => {
    const res = await get();
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toMatch(/\/api\/auth\/github$/);
    expect(res.cookies.get("xkg_oauth_return")?.value).toBe("https://xkg.xmu.sh/api/cli-login/approve?code=BCDF-GHJK");
  });

  it("asks to finish setup first", async () => {
    session = { ...ONBOARDED, github_repo: null };
    const html = await (await get()).text();
    expect(html).toMatch(/onboard/);
    expect(lib.getPendingCliLogin).not.toHaveBeenCalled();
  });

  it("shows the machine and the code to compare, escaped", async () => {
    session = ONBOARDED;
    lib.getPendingCliLogin.mockResolvedValue({ userCode: "BCDF-GHJK", label: "<b>evil</b>" });
    const html = await (await get()).text();
    expect(html).toContain("BCDF-GHJK");
    expect(html).toContain("&lt;b&gt;evil&lt;/b&gt;");
    expect(html).not.toContain("<b>evil</b>");
    expect(html).toContain('value="approve"');
  });

  it("says when the code is unknown or expired", async () => {
    session = ONBOARDED;
    lib.getPendingCliLogin.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/expired/i);
  });
});

describe("POST /api/cli-login/approve", () => {
  it("approves for the signed-in user", async () => {
    session = ONBOARDED;
    lib.approveCliLogin.mockResolvedValue(true);
    const res = await approve.POST(form({ code: "bcdf-ghjk", action: "approve" }));
    expect(res.status).toBe(200);
    expect(lib.approveCliLogin).toHaveBeenCalledWith("BCDF-GHJK", 7);
    expect(await res.text()).toMatch(/back to your terminal/i);
  });

  it("denies", async () => {
    session = ONBOARDED;
    lib.denyCliLogin.mockResolvedValue(true);
    await approve.POST(form({ code: "BCDF-GHJK", action: "deny" }));
    expect(lib.denyCliLogin).toHaveBeenCalledWith("BCDF-GHJK");
    expect(lib.approveCliLogin).not.toHaveBeenCalled();
  });

  it("treats a missing action as deny", async () => {
    session = ONBOARDED;
    lib.denyCliLogin.mockResolvedValue(true);
    await approve.POST(form({ code: "BCDF-GHJK" }));
    expect(lib.approveCliLogin).not.toHaveBeenCalled();
  });

  it("refuses a post from another site", async () => {
    session = ONBOARDED;
    const res = await approve.POST(form({ code: "BCDF-GHJK", action: "approve" }, { "sec-fetch-site": "cross-site" }));
    expect(res.status).toBe(403);
    expect(lib.approveCliLogin).not.toHaveBeenCalled();
  });

  it("needs a session", async () => {
    const res = await approve.POST(form({ code: "BCDF-GHJK", action: "approve" }));
    expect(res.status).toBe(401);
    expect(lib.approveCliLogin).not.toHaveBeenCalled();
  });

  it("says when the login can't be approved any more", async () => {
    session = ONBOARDED;
    lib.approveCliLogin.mockResolvedValue(false);
    const res = await approve.POST(form({ code: "BCDF-GHJK", action: "approve" }));
    expect(res.status).toBe(410);
  });
});

describe("POST /api/rotate-key", () => {
  it("also removes every machine key", async () => {
    session = ONBOARDED;
    const res = await rotate.POST();
    expect(res.status).toBe(200);
    expect(deleteCliKeys).toHaveBeenCalledWith(7);
  });
});
