/**
 * OAuth 2.1 primitives for the MCP remote connector.
 *
 * Design goals (kept intentionally simple, matching the rest of the codebase):
 *  - Access and refresh tokens are self-contained, HMAC-signed strings — no token
 *    table, no DB lookup to validate a token beyond loading the user by id.
 *  - Authorization codes ARE stored (lib/db) so they can be single-use and carry
 *    the PKCE challenge.
 *  - PKCE (S256) is mandatory, per OAuth 2.1 / the MCP authorization spec.
 *
 * Everything is signed with SESSION_SECRET (already required by the app), so no
 * new environment variable is introduced.
 */

import crypto from "crypto";
import { env } from "./env";

// Access tokens are short-lived; refresh tokens rotate them without a new consent.
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
export const AUTH_CODE_TTL_SECONDS = 60 * 5; // 5 minutes

// The single OAuth scope this server understands.
export const MCP_SCOPE = "mcp";

type TokenKind = "access" | "refresh";

export interface TokenPayload {
  k: TokenKind; // token kind
  u: number; // user id
  c: string; // client id
  v: number; // token_version — bumping it revokes every outstanding token
  exp: number; // expiry (epoch seconds)
  jti?: string; // refresh tokens only: id used for single-use + reuse detection
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(data: string): string {
  return crypto.createHmac("sha256", env.sessionSecret).update(data).digest("base64url");
}

/** Build a self-contained, HMAC-signed token: `<b64url(payload)>.<sig>`. */
function issueToken(
  kind: TokenKind,
  userId: number,
  clientId: string,
  ttlSeconds: number,
  tokenVersion: number,
  jti?: string,
): string {
  const payload: TokenPayload = {
    k: kind,
    u: userId,
    c: clientId,
    v: tokenVersion,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    ...(jti ? { jti } : {}),
  };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

export function issueAccessToken(userId: number, clientId: string, tokenVersion: number): string {
  return issueToken("access", userId, clientId, ACCESS_TOKEN_TTL_SECONDS, tokenVersion);
}

/**
 * Issue a refresh token. The `jti` is recorded by the caller so the token can
 * be single-use with reuse detection (OAuth 2.1 for public clients).
 */
export function issueRefreshToken(
  userId: number,
  clientId: string,
  tokenVersion: number,
): { token: string; jti: string; expiresAt: Date } {
  const jti = `xkg_rt_${crypto.randomBytes(24).toString("hex")}`;
  const token = issueToken("refresh", userId, clientId, REFRESH_TOKEN_TTL_SECONDS, tokenVersion, jti);
  return { token, jti, expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000) };
}

/** Verify a token's signature and expiry. Returns the payload or null. */
export function verifyToken(token: string, expectedKind: TokenKind): TokenPayload | null {
  const dot = token.lastIndexOf(".");
  if (dot === -1) return null;

  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  // Constant-time signature comparison.
  const expected = sign(body);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as TokenPayload;
  } catch {
    return null;
  }

  if (payload.k !== expectedKind) return null;
  if (typeof payload.u !== "number" || typeof payload.exp !== "number") return null;
  if (typeof payload.v !== "number") return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;

  return payload;
}

// ── PKCE ──

/** Verify a PKCE code_verifier against a stored S256 (or plain) challenge. */
export function verifyPkce(verifier: string, challenge: string, method: string): boolean {
  if (!verifier || !challenge) return false;

  if (method === "S256") {
    const hashed = crypto.createHash("sha256").update(verifier).digest("base64url");
    const a = Buffer.from(hashed);
    const b = Buffer.from(challenge);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  if (method === "plain") {
    const a = Buffer.from(verifier);
    const b = Buffer.from(challenge);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  return false;
}

// ── Random identifiers ──

export function randomAuthCode(): string {
  return `xkg_ac_${crypto.randomBytes(32).toString("hex")}`;
}

export function randomClientId(): string {
  return `xkg_client_${crypto.randomBytes(16).toString("hex")}`;
}

// ── Metadata ──

// Each function takes the origin the client called (see lib/origin): a
// connector set up on an older address must be told about that address, or it
// rejects the metadata as describing a different server.

/** The MCP resource URL this authorization server protects. */
export function mcpResourceUrl(origin: string = env.appUrl): string {
  return `${origin}/api/mcp`;
}

/** RFC 9728 — OAuth 2.0 Protected Resource Metadata. */
export function protectedResourceMetadata(origin: string = env.appUrl): Record<string, unknown> {
  return {
    resource: mcpResourceUrl(origin),
    authorization_servers: [origin],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://github.com/xmu-labs/xkg",
  };
}

/** RFC 8414 — OAuth 2.0 Authorization Server Metadata. */
export function authorizationServerMetadata(origin: string = env.appUrl): Record<string, unknown> {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/api/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    scopes_supported: [MCP_SCOPE],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };
}

/** The WWW-Authenticate value the MCP endpoint returns on an unauthenticated request. */
export function wwwAuthenticateHeader(origin: string = env.appUrl): string {
  const metadataUrl = `${origin}/.well-known/oauth-protected-resource`;
  return `Bearer resource_metadata="${metadataUrl}"`;
}
