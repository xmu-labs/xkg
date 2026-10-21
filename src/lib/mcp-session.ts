/**
 * MCP Streamable HTTP session identifiers.
 *
 * The transport lets a server hand the client an `Mcp-Session-Id` on the
 * `initialize` response, which the client then echoes on every subsequent
 * request. xkg runs on serverless (Vercel) with no shared memory between
 * invocations, so the id is a self-contained, HMAC-signed token — validating it
 * needs only the signing secret, no session store. It binds the transport
 * session to a user id and an issue time (for expiry).
 *
 * This is transport bookkeeping, not authentication: every request is still
 * authenticated by its bearer token (OAuth access token or legacy API key).
 */

import crypto from "crypto";
import { env } from "./env";

const SESSION_TTL_SECONDS = 60 * 60 * 24; // 24 hours

interface SessionPayload {
  u: number; // user id
  iat: number; // issued-at (epoch seconds)
}

function sign(body: string): string {
  // Domain-separated from other HMAC uses of the same secret.
  return crypto.createHmac("sha256", env.sessionSecret).update(`mcp-session:${body}`).digest("base64url");
}

/** Issue a signed session id for a user. The value is visible-ASCII only. */
export function issueMcpSessionId(userId: number): string {
  const payload: SessionPayload = { u: userId, iat: Math.floor(Date.now() / 1000) };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

/** Verify a session id's signature and expiry. Returns the user id or null. */
export function verifyMcpSessionId(id: string): { userId: number } | null {
  const dot = id.lastIndexOf(".");
  if (dot === -1) return null;

  const body = id.slice(0, dot);
  const sig = id.slice(dot + 1);

  const expected = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as SessionPayload;
  } catch {
    return null;
  }

  if (typeof payload.u !== "number" || typeof payload.iat !== "number") return null;
  if (payload.iat + SESSION_TTL_SECONDS < Math.floor(Date.now() / 1000)) return null;

  return { userId: payload.u };
}
