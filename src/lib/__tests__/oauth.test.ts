import { describe, it, expect, beforeAll } from "vitest";
import crypto from "crypto";

// env reads these lazily via getters, so setting them before import is enough.
beforeAll(() => {
  process.env.SESSION_SECRET = "test-secret-for-oauth";
  process.env.NEXT_PUBLIC_APP_URL = "https://xkg.example.com";
});

const oauth = await import("../oauth");

describe("access/refresh token round-trip", () => {
  it("issues and verifies an access token", () => {
    const token = oauth.issueAccessToken(42, "client-abc", 0);
    const payload = oauth.verifyToken(token, "access");
    expect(payload).not.toBeNull();
    expect(payload!.u).toBe(42);
    expect(payload!.c).toBe("client-abc");
    expect(payload!.k).toBe("access");
  });

  it("issues and verifies a refresh token", () => {
    const { token, jti } = oauth.issueRefreshToken(7, "client-xyz", 0);
    expect(oauth.verifyToken(token, "refresh")!.u).toBe(7);
    // The jti is what makes the token single-use and reuse-detectable.
    expect(oauth.verifyToken(token, "refresh")!.jti).toBe(jti);
  });

  it("rejects a token verified against the wrong kind", () => {
    const access = oauth.issueAccessToken(1, "c", 0);
    expect(oauth.verifyToken(access, "refresh")).toBeNull();
    const refresh = oauth.issueRefreshToken(1, "c", 0).token;
    expect(oauth.verifyToken(refresh, "access")).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const token = oauth.issueAccessToken(1, "c", 0);
    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ k: "access", u: 999, c: "c", v: 0, exp: 9999999999 })).toString("base64url");
    expect(oauth.verifyToken(`${forged}.${sig}`, "access")).toBeNull();
    // sanity: the untouched token still verifies
    expect(oauth.verifyToken(`${body}.${sig}`, "access")).not.toBeNull();
  });

  it("rejects an expired token", () => {
    // Forge a correctly-signed but already-expired token using the same secret.
    const past = Math.floor(Date.now() / 1000) - 10;
    const body = Buffer.from(JSON.stringify({ k: "access", u: 5, c: "c", exp: past })).toString("base64url");
    const sig = crypto.createHmac("sha256", "test-secret-for-oauth").update(body).digest("base64url");
    expect(oauth.verifyToken(`${body}.${sig}`, "access")).toBeNull();
  });

  it("rejects garbage input", () => {
    expect(oauth.verifyToken("not-a-token", "access")).toBeNull();
    expect(oauth.verifyToken("", "access")).toBeNull();
  });

  it("carries token_version so a bump can revoke outstanding tokens", () => {
    const token = oauth.issueAccessToken(42, "c", 7);
    expect(oauth.verifyToken(token, "access")!.v).toBe(7);
  });

  it("rejects a payload with a non-numeric token_version", () => {
    const body = Buffer.from(
      JSON.stringify({ k: "access", u: 5, c: "c", v: "nope", exp: 9999999999 }),
    ).toString("base64url");
    const sig = crypto.createHmac("sha256", "test-secret-for-oauth").update(body).digest("base64url");
    expect(oauth.verifyToken(`${body}.${sig}`, "access")).toBeNull();
  });

  it("gives every refresh token a distinct jti", () => {
    const a = oauth.issueRefreshToken(1, "c", 0);
    const b = oauth.issueRefreshToken(1, "c", 0);
    expect(a.jti).not.toBe(b.jti);
    expect(a.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("PKCE verification", () => {
  it("accepts a valid S256 verifier/challenge pair", () => {
    const verifier = "the-quick-brown-fox-code-verifier-1234567890";
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    expect(oauth.verifyPkce(verifier, challenge, "S256")).toBe(true);
  });

  it("rejects a mismatched S256 verifier", () => {
    const challenge = crypto.createHash("sha256").update("correct-verifier").digest("base64url");
    expect(oauth.verifyPkce("wrong-verifier", challenge, "S256")).toBe(false);
  });

  it("supports the plain method", () => {
    expect(oauth.verifyPkce("abc", "abc", "plain")).toBe(true);
    expect(oauth.verifyPkce("abc", "xyz", "plain")).toBe(false);
  });

  it("rejects unknown methods and empty inputs", () => {
    expect(oauth.verifyPkce("abc", "abc", "S512")).toBe(false);
    expect(oauth.verifyPkce("", "abc", "S256")).toBe(false);
    expect(oauth.verifyPkce("abc", "", "S256")).toBe(false);
  });
});

describe("metadata documents", () => {
  it("advertises the correct MCP resource and endpoints", () => {
    const prm = oauth.protectedResourceMetadata();
    expect(prm.resource).toBe("https://xkg.example.com/api/mcp");
    expect(prm.authorization_servers).toEqual(["https://xkg.example.com"]);

    const asm = oauth.authorizationServerMetadata();
    expect(asm.issuer).toBe("https://xkg.example.com");
    expect(asm.authorization_endpoint).toBe("https://xkg.example.com/api/oauth/authorize");
    expect(asm.token_endpoint).toBe("https://xkg.example.com/api/oauth/token");
    expect(asm.registration_endpoint).toBe("https://xkg.example.com/api/oauth/register");
    expect(asm.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("points WWW-Authenticate at the protected-resource metadata", () => {
    expect(oauth.wwwAuthenticateHeader()).toContain(
      'resource_metadata="https://xkg.example.com/.well-known/oauth-protected-resource"',
    );
  });
});
