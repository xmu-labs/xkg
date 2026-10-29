import { NextRequest, NextResponse } from "next/server";
import { adminAuthorized } from "@/lib/admin-auth";
import { getUserById } from "@/lib/db";
import { rebuildHandoffIndex } from "@/lib/handoff-learning";

// Operator rebuild of what xkg learned from one user's handoff answers: drops
// their handoff_scores rows and makes them again from git (HANDOFFS.md and the
// captures' Handoff logs). Returns counts only.
// POST /api/admin/rebuild-handoff-index?user=<id> with the x-admin-secret header.
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!adminAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const id = Number(req.nextUrl.searchParams.get("user") ?? "");
  if (!Number.isSafeInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Pass ?user=<id>" }, { status: 400 });
  }

  try {
    const user = await getUserById(id);
    if (!user) return NextResponse.json({ error: "No such user" }, { status: 404 });
    const counts = await rebuildHandoffIndex(user, new Date().toISOString().slice(0, 10));
    return NextResponse.json({ user: id, ...counts });
  } catch (err) {
    console.error("handoff index rebuild failed:", err);
    return NextResponse.json({ error: "Failed to rebuild the handoff index" }, { status: 500 });
  }
}
