import { NextRequest, NextResponse } from "next/server";
import { adminAuthorized } from "@/lib/admin-auth";
import { applyGateStats } from "@/lib/apply-events";

const DEFAULT_WEEKS = 4;
const MAX_WEEKS = 52;

// Operator read of the apply metric: distinct captures applied per user and
// week, with commit, with a reason and by agent. Counts only.
// GET /api/admin/apply-stats?weeks=4 with the x-admin-secret header.
export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!adminAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const asked = Number.parseInt(req.nextUrl.searchParams.get("weeks") ?? "", 10);
  const weeks = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), MAX_WEEKS) : DEFAULT_WEEKS;

  try {
    const today = new Date().toISOString().slice(0, 10);
    return NextResponse.json({ weeks: await applyGateStats(today, weeks) });
  } catch (err) {
    console.error("apply stats read failed:", err);
    return NextResponse.json({ error: "Failed to read apply stats" }, { status: 500 });
  }
}
