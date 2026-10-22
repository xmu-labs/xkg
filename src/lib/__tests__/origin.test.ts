import { describe, it, expect, beforeEach } from "vitest";
import { canonicalOrigin, canonicalRedirect, requestOrigin } from "../origin";

const NEW = "https://xkg.xmu.sh";
const OLD = "https://mnemos-capture.vercel.app";

/** A request as the platform delivers it: the address lives in the Host headers. */
function request(url: string, method = "GET"): Request {
  const u = new URL(url);
  return new Request(`http://127.0.0.1:3000${u.pathname}${u.search}`, {
    method,
    headers: { "x-forwarded-host": u.host, "x-forwarded-proto": u.protocol.replace(":", "") },
  });
}

function redirect(url: string, method = "GET"): string | null {
  return canonicalRedirect(request(url, method))?.toString() ?? null;
}

function originFor(url: string): string {
  return requestOrigin(request(url));
}

describe("after the switch (canonical = xkg.xmu.sh)", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = NEW;
  });

  it("uses the configured app URL as the canonical origin", () => {
    expect(canonicalOrigin()).toBe(NEW);
  });

  it("describes the old address to clients that call the old address", () => {
    expect(originFor(`${OLD}/api/oauth/protected-resource`)).toBe(OLD);
    expect(originFor(`${NEW}/api/oauth/protected-resource`)).toBe(NEW);
  });

  it("never echoes an unknown host back into metadata", () => {
    expect(originFor("https://evil.example/api/oauth/protected-resource")).toBe(NEW);
    expect(originFor("https://mnemos-capture-git-x-xmu-sh.vercel.app/")).toBe(NEW);
    expect(requestOrigin(new Request("http://127.0.0.1:3000/"))).toBe(NEW);
  });

  it("reads the address from the Host header when there is no forwarded host", () => {
    const req = new Request("http://127.0.0.1:3000/api/oauth/protected-resource", {
      headers: { host: "mnemos-capture.vercel.app", "x-forwarded-proto": "https" },
    });
    expect(requestOrigin(req)).toBe(OLD);
  });

  it("sends browsers on the old address to the same page on the new one", () => {
    expect(redirect(`${OLD}/`)).toBe(`${NEW}/`);
    expect(redirect(`${OLD}/onboard?step=2`)).toBe(`${NEW}/onboard?step=2`);
    expect(redirect(`${OLD}/login`, "HEAD")).toBe(`${NEW}/login`);
  });

  it("moves sign-in and the consent screen, keeping the full authorization request", () => {
    expect(redirect(`${OLD}/api/auth/github`)).toBe(`${NEW}/api/auth/github`);
    const authorize = "/api/oauth/authorize?response_type=code&client_id=c1&code_challenge=x&state=s";
    expect(redirect(`${OLD}${authorize}`)).toBe(`${NEW}${authorize}`);
  });

  it("keeps machine endpoints on the address they were called on", () => {
    for (const path of [
      "/api/mcp",
      "/api/oauth/token",
      "/api/oauth/register",
      "/api/oauth/protected-resource",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-authorization-server/api/mcp",
      "/api/me",
      "/api/capture",
    ]) {
      expect(redirect(`${OLD}${path}`), path).toBeNull();
    }
  });

  it("does not match lookalike paths as sign-in", () => {
    expect(redirect(`${OLD}/api/authority`)).toBeNull();
    expect(redirect(`${OLD}/api/oauth/authorizer`)).toBeNull();
  });

  it("never redirects requests with a body", () => {
    expect(redirect(`${OLD}/api/oauth/authorize`, "POST")).toBeNull();
    expect(redirect(`${OLD}/`, "POST")).toBeNull();
  });

  it("leaves the canonical address and unknown hosts alone", () => {
    expect(redirect(`${NEW}/`)).toBeNull();
    expect(redirect("https://mnemos-capture-git-x-xmu-sh.vercel.app/")).toBeNull();
    expect(redirect("http://localhost:3000/")).toBeNull();
  });
});

describe("before the switch (canonical = mnemos-capture.vercel.app)", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = OLD;
  });

  it("changes nothing for the current address", () => {
    expect(redirect(`${OLD}/`)).toBeNull();
    expect(redirect(`${OLD}/api/auth/github`)).toBeNull();
    expect(originFor(`${OLD}/api/mcp`)).toBe(OLD);
  });

  it("already serves MCP discovery for the new address", () => {
    expect(originFor(`${NEW}/api/oauth/protected-resource`)).toBe(NEW);
    expect(redirect(`${NEW}/api/mcp`)).toBeNull();
  });

  it("sends browsers on the new address to the current one until the switch", () => {
    expect(redirect(`${NEW}/login`)).toBe(`${OLD}/login`);
  });
});
