import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSession, destroySession } from "@/lib/session";
import { DEVICE_COOKIE_NAME, LEGACY_DEVICE_COOKIE_NAMES } from "@/lib/device";
import { confirmsDeletion, deleteAccount } from "@/lib/account";

// Delete the signed-in user's account and everything xkg stores about them.
// Captures stay in the user's GitHub repository; xkg never held them.
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  try {
    const user = await getSession();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    let body: { confirm?: unknown };
    try {
      body = (await req.json()) as { confirm?: unknown };
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (!confirmsDeletion(user, body.confirm)) {
      return NextResponse.json(
        { error: "Type your GitHub username exactly to confirm." },
        { status: 400 },
      );
    }

    const { githubRevoked } = await deleteAccount(user);

    await destroySession();
    const cookieStore = await cookies();
    for (const name of [DEVICE_COOKIE_NAME, ...LEGACY_DEVICE_COOKIE_NAMES]) cookieStore.delete(name);

    return NextResponse.json({ ok: true, githubRevoked });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete account";
    return NextResponse.json({ error: `[account] ${message}` }, { status: 500 });
  }
}
