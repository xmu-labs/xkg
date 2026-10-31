import { NextRequest, NextResponse } from "next/server";
import { consumeQuota } from "@/lib/rate-limit";
import { checkCapture, inboxPage } from "@/lib/captures";
import { fail, githubFailure, jsonBody, repoUser } from "@/lib/captures-route";

const CHECKS_PER_HOUR = 30;
const PAGE = 20;

/**
 * The Your knowledge page's quiet source check, run as the page opens: one
 * page of inbox captures, each checked for an offline source and a
 * low-confidence extraction. It only adds notes; the user archives from the
 * list. Body: { offset? }.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const user = await repoUser();
    if (user instanceof NextResponse) return user;
    const body = await jsonBody(req);
    if (!body) return fail(400, "Body must be JSON.");

    const quota = await consumeQuota(`check-links:user:${user.id}`, CHECKS_PER_HOUR);
    if (!quota.allowed) {
      return fail(429, `Rate limit reached: ${quota.limit} link checks per hour.`, { "Retry-After": String(quota.resetIn) });
    }

    const offset = typeof body.offset === "number" ? body.offset : 0;
    const inbox = await inboxPage(user, { offset, limit: PAGE }, PAGE);
    if (!inbox) return NextResponse.json({ results: [], total: 0, next: null });
    const results = await Promise.all(inbox.page.items.map((f) => checkCapture(user, f.name)));
    return NextResponse.json({ results, total: inbox.page.total, next: inbox.page.nextOffset });
  } catch (err) {
    const github = githubFailure(err);
    if (github) return github;
    return fail(500, `[check] ${err instanceof Error ? err.message : "Failed to check links"}`);
  }
}
