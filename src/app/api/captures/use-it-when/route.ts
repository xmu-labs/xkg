import { NextRequest, NextResponse } from "next/server";
import { consumeQuota } from "@/lib/rate-limit";
import { withSpendMeter } from "@/lib/llm-spend";
import { backfillEstimate, backfillPage } from "@/lib/use-it-when-backfill";
import { fail, githubFailure, jsonBody, repoUser } from "@/lib/captures-route";

const PAGES_PER_HOUR = 60;
const PAGE = 5;
const CAPTURE_PATH = /^(inbox|applied)\/[^/]+\.md$/;

/**
 * Backfill of the "Use it when" line for captures saved before it existed.
 * Body `{ estimate: true }`: how many captures and the most it could cost on
 * the user's model, with no model call. Body `{ after? }`: one page of up to
 * 5 captures, each read, given a line by the user's model and written back;
 * the answer's `next` is the `after` for the next page, null when done.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const user = await repoUser();
    if (user instanceof NextResponse) return user;
    if (!user.llm_api_key) return fail(400, "Add your AI key in Settings first. The lines are written by your own model.");
    const body = await jsonBody(req);
    if (!body) return fail(400, "Body must be JSON.");

    // `scope` keys the page's saved progress to this account and repo.
    if (body.estimate === true) return NextResponse.json({ ...(await backfillEstimate(user)), scope: `${user.id}:${user.github_repo}` });

    const quota = await consumeQuota(`use-it-when:user:${user.id}`, PAGES_PER_HOUR);
    if (!quota.allowed) {
      return fail(429, `Rate limit reached: ${quota.limit} pages per hour. It picks up where it stopped.`, { "Retry-After": String(quota.resetIn) });
    }
    const after = typeof body.after === "string" && CAPTURE_PATH.test(body.after) ? body.after : undefined;
    return NextResponse.json(await withSpendMeter(user.id, () => backfillPage(user, { after, limit: PAGE })));
  } catch (err) {
    const github = githubFailure(err);
    if (github) return github;
    return fail(500, `[use-it-when] ${err instanceof Error ? err.message : "Failed to add lines"}`);
  }
}
