import { NextRequest, NextResponse } from "next/server";
import { createCliLogin, POLL_INTERVAL_SECONDS } from "@/lib/cli-login";
import { consumeQuota } from "@/lib/rate-limit";
import { canonicalOrigin } from "@/lib/origin";

// Browser sign-in for the CLI, step 1 (see lib/cli-login): the CLI asks for a
// code to show the user and a device code to poll with. No session; limited
// per address so nobody fills the table.

const STARTS_PER_HOUR = 20;

function clientAddress(req: NextRequest): string {
  return req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const quota = await consumeQuota(`cli-login:ip:${clientAddress(req)}`, STARTS_PER_HOUR);
    if (!quota.allowed) {
      return NextResponse.json({ error: "Too many sign-in attempts. Try again later." }, { status: 429, headers: { "Retry-After": String(quota.resetIn) } });
    }
    const body = (await req.json().catch(() => ({}))) as { label?: unknown };
    const label = typeof body.label === "string" ? body.label : "";
    const login = await createCliLogin(label);
    const verificationUri = `${canonicalOrigin()}/api/cli-login/approve`;
    return NextResponse.json({
      device_code: login.deviceCode,
      user_code: login.userCode,
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?code=${login.userCode}`,
      expires_in: login.expiresIn,
      interval: POLL_INTERVAL_SECONDS,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[cli-login/start]", err);
    return NextResponse.json({ error: "Could not start sign-in." }, { status: 500 });
  }
}
