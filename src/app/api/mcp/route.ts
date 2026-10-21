/**
 * MCP Streamable HTTP transport.
 *
 * This route owns the wire: auth, CORS/origin checks, JSON-RPC framing and
 * SSE. Tool schemas live in lib/mcp/tools and the implementations in
 * lib/mcp/handlers, so what changes here is protocol behavior, not features.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserByApiKey, getUserById } from "@/lib/db";
import type { User } from "@/lib/db";
import { verifyToken, wwwAuthenticateHeader } from "@/lib/oauth";
import { issueMcpSessionId, verifyMcpSessionId } from "@/lib/mcp-session";
import { env } from "@/lib/env";
import { TOOLS, type ToolName } from "@/lib/mcp/tools";
import { HANDLERS } from "@/lib/mcp/handlers";

// ── Types ──

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}


// ── MCP Streamable HTTP transport ──

// CORS so browser-based MCP clients (e.g. claude.ai web connector) can call the
// endpoint and read the WWW-Authenticate challenge that drives OAuth discovery.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
};

// The newest MCP protocol revision this server implements; echoed back to a
// client that doesn't state its own version on initialize.
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

/** 401 that tells the client where to discover the OAuth authorization server. */
function unauthorized(message: string): NextResponse {
  return NextResponse.json(
    { jsonrpc: "2.0", error: { code: -32600, message } },
    { status: 401, headers: { ...CORS, "WWW-Authenticate": wwwAuthenticateHeader() } },
  );
}

/**
 * Serialize a JSON-RPC response. The Streamable HTTP transport lets the server
 * answer a POST with either a plain JSON body or a one-message SSE stream; we
 * pick based on the client's Accept header (JSON preferred when both are ok).
 */
function respond(payload: unknown, wantsSse: boolean, extraHeaders: Record<string, string> = {}): NextResponse {
  if (wantsSse) {
    const body = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
    return new NextResponse(body, {
      headers: {
        ...CORS,
        ...extraHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }
  return NextResponse.json(payload, { headers: { ...CORS, ...extraHeaders } });
}

/**
 * DNS-rebinding protection (required by the transport spec). Native apps send no
 * Origin; browsers do. Allow https and loopback, reject other explicit origins.
 * Bearer-token auth already gates the endpoint, so this stays permissive.
 */
function originRejected(req: NextRequest): NextResponse | null {
  const origin = req.headers.get("origin");
  if (!origin) return null;
  try {
    const u = new URL(origin);
    if (u.protocol === "https:") return null;
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return null;
  } catch {
    // malformed Origin → reject below
  }
  return NextResponse.json(
    { jsonrpc: "2.0", error: { code: -32600, message: "Origin not allowed" } },
    { status: 403, headers: CORS },
  );
}

/**
 * Resolve the caller from the Authorization header. Accepts either an OAuth 2.1
 * access token (Claude iOS/desktop/web remote connector) or a legacy static
 * `xkg_...`, `xmu_...`, or `mnemos_...` API key (CLI / stdio proxy). Returns null when neither validates.
 */
async function resolveUser(token: string): Promise<User | null> {
  // OAuth access token first (self-contained, signed).
  const payload = verifyToken(token, "access");
  if (payload) {
    const user = await getUserById(payload.u);
    if (!user) return null;
    // A bumped token_version retires every token issued before the bump.
    if ((user.token_version ?? 0) !== payload.v) return null;
    return user;
  }
  // Fall back to the legacy static API key.
  return getUserByApiKey(token);
}

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

// GET opens a server→client SSE stream. xkg has no server-initiated messages,
// so per the spec it MAY decline with 405 — the client just won't open a stream.
export function GET(): NextResponse {
  return new NextResponse(null, { status: 405, headers: { ...CORS, Allow: "POST, DELETE, OPTIONS" } });
}

// DELETE terminates a session. Sessions are stateless signed tokens, so there's
// nothing server-side to purge — acknowledge the client's termination.
export function DELETE(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

// The inner handler already catches per-request tool failures, but the steps
// before it — origin check, token resolution, which reads the database — could
// still throw and make Next.js answer with HTML. An MCP client parsing that as
// JSON-RPC gets a meaningless error, so failures are shaped as JSON-RPC here.
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    return await handlePost(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    console.error("[mcp] unhandled error:", err);
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32603, message: `[mcp] ${message}` } },
      { status: 500, headers: CORS },
    );
  }
}

async function handlePost(req: NextRequest): Promise<NextResponse> {
  const originError = originRejected(req);
  if (originError) return originError;

  const authHeader = req.headers.get("authorization");
  const token = authHeader?.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    return unauthorized("Missing access token");
  }

  const user = await resolveUser(token);
  if (!user) {
    return unauthorized("Invalid or expired access token");
  }

  // Content negotiation: SSE only when the client accepts it and not JSON.
  const accept = req.headers.get("accept") ?? "";
  const acceptsJson = accept.includes("application/json") || accept.includes("*/*") || accept.trim() === "";
  const wantsSse = accept.includes("text/event-stream") && !acceptsJson;

  let body: JsonRpcRequest;
  try {
    body = (await req.json()) as JsonRpcRequest;
  } catch {
    return respond({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, wantsSse);
  }
  const { method, id, params } = body;

  // Session check for post-initialize requests. Lenient by design: a missing
  // Mcp-Session-Id is allowed (the legacy stdio proxy never sends one), but a
  // present-and-invalid one gets 404 so the client knows to re-initialize.
  const providedSession = req.headers.get("mcp-session-id");
  if (method !== "initialize" && providedSession && !verifyMcpSessionId(providedSession)) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: id ?? null, error: { code: -32001, message: "Session not found" } },
      { status: 404, headers: CORS },
    );
  }

  // Notifications carry no id and expect no JSON-RPC response (202 Accepted).
  if (typeof method === "string" && method.startsWith("notifications/")) {
    return new NextResponse(null, { status: 202, headers: CORS });
  }

  try {
    switch (method) {
      case "initialize": {
        // Echo the client's requested protocol version when it states one.
        const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
        const protocolVersion = typeof requested === "string" ? requested : DEFAULT_PROTOCOL_VERSION;
        // Hand the client a session id it will echo on subsequent requests.
        const sessionId = issueMcpSessionId(user.id);
        return respond(
          {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion,
              capabilities: { tools: {} },
              // `title`, `websiteUrl`, and `icons` are best-effort branding hints:
              // clients that support them can show the xkg name and logo instead
              // of a generated letter avatar. Unknown fields are ignored by others.
              serverInfo: {
                name: "xkg",
                title: "xkg",
                version: "1.0.0",
                websiteUrl: env.appUrl,
                icons: [
                  { src: `${env.appUrl}/connector-icon.png`, mimeType: "image/png", sizes: ["512x512"], theme: "light" },
                  { src: `${env.appUrl}/connector-icon-dark.png`, mimeType: "image/png", sizes: ["512x512"], theme: "dark" },
                  { src: `${env.appUrl}/connector-icon-192.png`, mimeType: "image/png", sizes: ["192x192"], theme: "light" },
                  { src: `${env.appUrl}/connector-icon-192-dark.png`, mimeType: "image/png", sizes: ["192x192"], theme: "dark" },
                ],
              },
            },
          },
          wantsSse,
          { "Mcp-Session-Id": sessionId },
        );
      }

      case "tools/list":
        return respond({ jsonrpc: "2.0", id, result: { tools: TOOLS } }, wantsSse);

      case "tools/call": {
        const toolName = (params as { name: string }).name;
        const toolArgs = (params as { arguments?: Record<string, unknown> }).arguments ?? {};

        const handler = HANDLERS[toolName as ToolName];
        if (!handler) {
          return respond(
            { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${toolName}` } },
            wantsSse,
          );
        }
        const result = await handler(user, toolArgs as never);

        return respond(
          { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: result }] } },
          wantsSse,
        );
      }

      default:
        return respond(
          { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } },
          wantsSse,
        );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return respond(
      {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: `Error: ${message}` }], isError: true },
      },
      wantsSse,
    );
  }
}
