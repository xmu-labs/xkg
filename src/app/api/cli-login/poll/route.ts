import { NextRequest, NextResponse } from "next/server";
import { pollCliLogin } from "@/lib/cli-login";

// Browser sign-in for the CLI, step 3 (see lib/cli-login): the CLI polls with
// its device code until the user approves or denies, or the code expires. The
// key is handed over once.

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = (await req.json().catch(() => ({}))) as { device_code?: unknown };
    if (typeof body.device_code !== "string" || !body.device_code) {
      return NextResponse.json({ error: "device_code is required." }, { status: 400 });
    }
    const result = await pollCliLogin(body.device_code);
    const payload = result.status === "approved" ? { status: "approved", api_key: result.apiKey } : { status: result.status };
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[cli-login/poll]", err);
    return NextResponse.json({ error: "Could not check sign-in." }, { status: 500 });
  }
}
