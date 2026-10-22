import { NextRequest, NextResponse } from "next/server";
import { protectedResourceMetadata } from "@/lib/oauth";
import { requestOrigin } from "@/lib/origin";

// RFC 9728 — served at /.well-known/oauth-protected-resource (via rewrite).
// Public, cacheable, CORS-open so any MCP client can discover the auth server.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export function GET(req: NextRequest): NextResponse {
  return NextResponse.json(protectedResourceMetadata(requestOrigin(req)), { headers: CORS });
}

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}
