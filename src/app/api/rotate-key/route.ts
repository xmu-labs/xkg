import { NextResponse } from "next/server";
import crypto from "crypto";
import { getSession, createSession } from "@/lib/session";
import { updateUserApiKey, revokeUserTokens, deleteCliKeys } from "@/lib/db";

// Regenerate the MCP/CLI API key for the signed-in user.
// This is the only path (besides full onboarding) that mints a new api_key.
// Rotating overwrites the stored key, so any previously issued key stops working.
export async function POST(): Promise<NextResponse> {
  try {
    const user = await getSession();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    // Onboarding sets up the knowledge repo + LLM key. Without it, an MCP key is useless.
    if (!user.github_repo) {
      return NextResponse.json(
        { error: "Complete onboarding first — visit /onboard before generating an MCP key." },
        { status: 400 },
      );
    }

    const apiKey = `xkg_${crypto.randomBytes(24).toString("hex")}`;
    await updateUserApiKey(user.id, apiKey);
    // Keys from browser sign-in (one per machine) are revoked with it.
    await deleteCliKeys(user.id);

    // Rotating the key is the user's "revoke my access" lever, so it must also
    // retire OAuth access/refresh tokens — otherwise a leaked connector token
    // would outlive the rotation by up to 30 days. Re-issue this browser's
    // session against the new version so generating a key does not sign them out.
    const tokenVersion = await revokeUserTokens(user.id);
    await createSession(user.id, tokenVersion);

    return NextResponse.json({ ok: true, apiKey });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to rotate key";
    return NextResponse.json({ error: `[rotate-key] ${message}` }, { status: 500 });
  }
}
