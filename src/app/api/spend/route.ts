import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { monthSpend } from "@/lib/llm-spend";

/** Settings → AI model: what xkg spent with the user's key this month (an estimate). */
export async function GET(): Promise<NextResponse> {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    return NextResponse.json({ month: await monthSpend(user.id) });
  } catch (err) {
    return NextResponse.json({ error: `[spend] ${err instanceof Error ? err.message : "Failed to read spend"}` }, { status: 500 });
  }
}
