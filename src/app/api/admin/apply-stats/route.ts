import { NextRequest, NextResponse } from "next/server";
import { adminAuthorized } from "@/lib/admin-auth";
import { applyGateStats } from "@/lib/apply-events";
import { applySourceStats, matchingStats } from "@/lib/surface-events";
import { handoffStats } from "@/lib/handoff-events";

const DEFAULT_WEEKS = 4;
const MAX_WEEKS = 52;
const NO_SOURCES = { cardOnly: 0, briefingOnly: 0, both: 0, other: 0, none: 0 };

// Operator read of the apply metric: distinct captures applied per user and
// week, with commit, with a reason, by agent and by what surfaced them first;
// plus "Where it applies" matches and their median tokens, and handoffs
// (queued, offered, and each answer). Counts only.
// GET /api/admin/apply-stats?weeks=4 with the x-admin-secret header.
export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!adminAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const asked = Number.parseInt(req.nextUrl.searchParams.get("weeks") ?? "", 10);
  const weeks = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), MAX_WEEKS) : DEFAULT_WEEKS;

  try {
    const today = new Date().toISOString().slice(0, 10);
    const [gate, sources, matching, handoffs] = await Promise.all([
      applyGateStats(today, weeks),
      applySourceStats(today, weeks),
      matchingStats(today, weeks),
      handoffStats(today, weeks),
    ]);
    const sourcesOf = (userId: number, week: string) =>
      sources.find((s) => s.userId === userId && s.weekStart === week)?.sources ?? NO_SOURCES;
    return NextResponse.json({
      weeks: gate.map((w) => ({ ...w, sources: sourcesOf(w.userId, w.weekStart) })),
      matching,
      handoffs,
    });
  } catch (err) {
    console.error("apply stats read failed:", err);
    return NextResponse.json({ error: "Failed to read apply stats" }, { status: 500 });
  }
}
