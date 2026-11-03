import { NextRequest, NextResponse } from "next/server";
import { adminAuthorized } from "@/lib/admin-auth";
import { readStats, weeksOf } from "@/lib/admin-stats";

// Operator read of the apply metric: distinct captures applied per user and
// week, with commit, with a reason, by agent and by what surfaced them first;
// plus "Where it applies" matches and their median tokens, and handoffs
// (queued, offered, and each answer); and, for accounts that signed up in the
// window, the date of each setup step and where each one stopped. Counts and
// dates only.
// GET /api/admin/apply-stats?weeks=4 with the x-admin-secret header.
export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!adminAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    return NextResponse.json(await readStats(weeksOf(req.nextUrl.searchParams.get("weeks"))));
  } catch (err) {
    console.error("apply stats read failed:", err);
    return NextResponse.json({ error: "Failed to read apply stats" }, { status: 500 });
  }
}
