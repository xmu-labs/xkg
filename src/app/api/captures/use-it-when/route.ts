import { NextRequest, NextResponse } from "next/server";
import { consumeQuota } from "@/lib/rate-limit";
import { withSpendMeter } from "@/lib/llm-spend";
import { GitHubWriteLimitError, backfillEstimate, backfillPage } from "@/lib/use-it-when-backfill";
import { fail, githubFailure, jsonBody, repoUser } from "@/lib/captures-route";
import { llmErrorMessage } from "@/lib/friendly-error";

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
  let provider = "";
  try {
    const user = await repoUser();
    if (user instanceof NextResponse) return user;
    provider = user.llm_provider ?? "";
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
    // GitHub is limiting writes: the card pauses and picks up from this page.
    if (err instanceof GitHubWriteLimitError) {
      const minutes = Math.max(1, Math.ceil(err.retryAfter / 60));
      return fail(429, `GitHub is limiting how fast xkg can save to your repo. Start again in ${minutes === 1 ? "a minute" : `${minutes} minutes`} and it picks up where it stopped.`, { "Retry-After": String(err.retryAfter) });
    }
    // A refused key or unknown model stops the run (see backfillPage): say what to fix.
    const said = llmErrorMessage(err, provider);
    const message = err instanceof Error ? err.message : String(err);
    if (said !== message) {
      console.error("[use-it-when] provider refused:", message.slice(0, 300));
      return fail(502, said);
    }
    return fail(500, `[use-it-when] ${err instanceof Error ? err.message : "Failed to add lines"}`);
  }
}
