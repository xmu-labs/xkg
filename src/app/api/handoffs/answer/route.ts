import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { consumeQuota } from "@/lib/rate-limit";
import { repoName } from "@/lib/code-repos";
import { DECLINE_REASONS, recordAnswer } from "@/lib/handoff-outcomes";

/**
 * The capture card's "Not a fit". It records the same decline an agent
 * records with apply_capture (outcome declined), through the same code: one
 * HANDOFFS.md status, one Handoff log line, one learning signal. The body
 * names a capture, a repo and a reason, nothing else.
 */

const CAPTURE_PATH = /^(inbox|applied)\/[\w.-]+\.md$/;

function fail(status: number, error: string, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json({ error }, { status, headers });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const user = await getSession();
    if (!user) return fail(401, "Not authenticated");
    if (!user.github_repo) return fail(400, "Knowledge repo not configured. Complete onboarding first.");

    let body: { filename?: unknown; repo?: unknown; reason?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return fail(400, "Body must be JSON.");
    }
    const filename = typeof body?.filename === "string" && CAPTURE_PATH.test(body.filename) && !body.filename.includes("..") ? body.filename : null;
    if (!filename) return fail(400, "Name a capture in inbox/ or applied/.");
    const repo = typeof body.repo === "string" ? repoName(body.repo) : null;
    if (!repo) return fail(400, "Name the repo as owner/name.");
    const reason = DECLINE_REASONS.find((r) => r === body.reason);
    if (!reason) return fail(400, `Reason must be one of: ${DECLINE_REASONS.join(", ")}.`);

    const quota = await consumeQuota(`handoff:user:${user.id}`);
    if (!quota.allowed) {
      return fail(429, `Rate limit reached: ${quota.limit} handoffs per hour.`, { "Retry-After": String(quota.resetIn) });
    }

    const said = await recordAnswer(user, { filename, outcome: "declined", repo, reason });
    if (!said.startsWith("Recorded:")) return fail(502, said);
    return NextResponse.json({ ok: true, status: "declined", repo });
  } catch (err) {
    return fail(500, `[handoffs/answer] ${err instanceof Error ? err.message : "Failed to record the answer"}`);
  }
}
