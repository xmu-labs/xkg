import { NextRequest, NextResponse } from "next/server";
import { applyStats, clampWeeks } from "@/lib/captures";
import { weeklyApplyStats } from "@/lib/ledger";
import { fail, repoUser } from "@/lib/captures-route";

/** The captures page's weekly applies, newest week first. GET /api/apply-stats?weeks=4 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const user = await repoUser();
    if (user instanceof NextResponse) return user;
    const weeks = clampWeeks(req.nextUrl.searchParams.get("weeks"));
    const stats = (await applyStats(user, weeks)) ?? weeklyApplyStats("", new Date().toISOString().slice(0, 10), weeks);
    return NextResponse.json({ weeks: stats });
  } catch (err) {
    return fail(500, `[apply-stats] ${err instanceof Error ? err.message : "Failed to read applies"}`);
  }
}
