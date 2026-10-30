import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { listCodeRepos } from "@/lib/db";
import { readFile } from "@/lib/github";
import { consumeQuota } from "@/lib/rate-limit";
import { repoName } from "@/lib/code-repos";
import { readWhereSection } from "@/lib/where";
import { queueHandoff, type HandoffRow } from "@/lib/handoffs";
import { recordHandoffEvent } from "@/lib/handoff-events";
import { formatDate } from "@/lib/llm";

/**
 * The capture card's "Hand off to your coding agent" button. The body names a
 * capture and a repo, nothing else: the files and fit come from the capture's
 * own "Where it applies" section, so only what xkg suggested is queued, and
 * only for a repo it suggested.
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

    let body: { filename?: unknown; repo?: unknown };
    try {
      body = (await req.json()) as { filename?: unknown; repo?: unknown };
    } catch {
      return fail(400, "Body must be JSON.");
    }
    const filename = typeof body?.filename === "string" && CAPTURE_PATH.test(body.filename) && !body.filename.includes("..") ? body.filename : null;
    if (!filename) return fail(400, "Name a capture in inbox/ or applied/.");
    const repo = typeof body.repo === "string" ? repoName(body.repo) : null;
    if (!repo) return fail(400, "Name the repo as owner/name.");

    const quota = await consumeQuota(`handoff:user:${user.id}`);
    if (!quota.allowed) {
      return fail(429, `Rate limit reached: ${quota.limit} handoffs per hour.`, { "Retry-After": String(quota.resetIn) });
    }

    if (!(await listCodeRepos(user.id)).some((r) => r.repo === repo)) return fail(404, `No code map for ${repo}. Add it in Settings first.`);
    const file = await readFile(user.github_token, user.github_repo, filename);
    if (!file) return fail(404, "Capture not found.");

    // The best repo gets the files the card showed; an "also fits" repo gets
    // none, and the agent finds them. Nothing else is queued: the saved match
    // is what the card showed.
    const where = readWhereSection(file.content);
    if (!where) return fail(409, "This capture's match wasn't saved, so there's nothing to hand off. Try capturing it again.");
    const fit = where.repo === repo ? where.tier : where.also.find((a) => a.repo === repo)?.tier;
    if (!fit) return fail(409, `xkg didn't suggest ${repo} for this capture.`);
    const row: HandoffRow = {
      capture: filename,
      repo,
      kind: "code",
      files: where.repo === repo ? where.files : [],
      fit,
      status: "pending",
      since: formatDate(),
      source: "button",
    };

    const queued = await queueHandoff(user.github_token, user.github_repo, row);
    if (!queued) return fail(502, "Couldn't save the handoff to your knowledge repo. Try again in a moment.");
    if (queued.changed) await recordHandoffEvent(user.id, filename, repo, "queued", { source: "button" });
    return NextResponse.json({ ok: true, status: queued.row.status, repo });
  } catch (err) {
    return fail(500, `[handoffs] ${err instanceof Error ? err.message : "Failed to hand off the capture"}`);
  }
}
