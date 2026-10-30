import { NextRequest, NextResponse } from "next/server";
import { consumeQuota } from "@/lib/rate-limit";
import { readFileStrict } from "@/lib/github";
import { synthesizeTopic } from "@/lib/synthesis";
import { llmSettings } from "@/lib/llm";
import { fail, githubFailure, jsonBody, repoUser } from "@/lib/captures-route";

const RULES_PER_HOUR = 20;

/**
 * The captures page's "Make rules" button: turns the captures with a tag into
 * rules in RULES.md, on the user's own model and key. Body: { tag }.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const user = await repoUser();
    if (user instanceof NextResponse) return user;
    if (!user.llm_api_key) return fail(400, "Add your AI key in Settings first.");
    const body = await jsonBody(req);
    if (!body) return fail(400, "Body must be JSON.");
    const tag = typeof body.tag === "string" ? body.tag.trim().slice(0, 64) : "";
    if (!tag) return fail(400, "Pick a tag.");

    const quota = await consumeQuota(`rules:user:${user.id}`, RULES_PER_HOUR);
    if (!quota.allowed) {
      return fail(429, `Rate limit reached: ${quota.limit} rule runs per hour.`, { "Retry-After": String(quota.resetIn) });
    }

    const index = await readFileStrict(user.github_token, user.github_repo!, "INDEX.md");
    if (!index) return NextResponse.json({ topic: tag, rules: [] });
    const result = await synthesizeTopic(user.llm_api_key, user.github_token, user.github_repo!, tag, index.content, llmSettings(user));
    return NextResponse.json({ topic: result.topic, rules: result.rules });
  } catch (err) {
    const github = githubFailure(err);
    if (github) return github;
    return fail(500, `[rules] ${err instanceof Error ? err.message : "Failed to make rules"}`);
  }
}
