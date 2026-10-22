import { NextRequest, NextResponse } from "next/server";
import { authorizationServerMetadata } from "@/lib/oauth";
import { requestOrigin } from "@/lib/origin";

// RFC 8414 — served at /.well-known/oauth-authorization-server (via rewrite).
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export function GET(req: NextRequest): NextResponse {
  return NextResponse.json(authorizationServerMetadata(requestOrigin(req)), { headers: CORS });
}

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}
