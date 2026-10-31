import { NextRequest, NextResponse } from "next/server";
import { githubPut, readFileStrict } from "@/lib/github";
import { consumeQuota } from "@/lib/rate-limit";
import { captureName, parseIndexRows, type CaptureStatus } from "@/lib/captures";
import { explainCapture } from "@/lib/explain";
import { fail, githubFailure, jsonBody, repoUser } from "@/lib/captures-route";

const FOLDERS: CaptureStatus[] = ["inbox", "applied", "archived"];
const EXPLAINS_PER_HOUR = 60;

/**
 * Why and After for each file in a capture's "Where it applies", on the
 * user's own model. The lines are written into the capture file, so asking
 * again costs nothing. Body: { name: "2026-10-30-slug.md" }.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const user = await repoUser();
    if (user instanceof NextResponse) return user;
    const body = await jsonBody(req);
    const name = captureName(typeof body?.name === "string" ? body.name : null);
    if (!name) return fail(400, "That capture name isn't valid.");

    const quota = await consumeQuota(`explain:user:${user.id}`, EXPLAINS_PER_HOUR);
    if (!quota.allowed) {
      return fail(429, `Rate limit reached: ${quota.limit} explanations per hour.`, { "Retry-After": String(quota.resetIn) });
    }

    const repo = user.github_repo!;
    const index = await readFileStrict(user.github_token, repo, "INDEX.md");
    const listed = index ? parseIndexRows(index.content).find((r) => r.filename === name)?.status : undefined;
    for (const folder of listed ? [listed, ...FOLDERS.filter((f) => f !== listed)] : FOLDERS) {
      const path = `${folder}/${name}`;
      const file = await readFileStrict(user.github_token, repo, path);
      if (!file) continue;
      const explained = await explainCapture(user, file.content);
      if (!explained) return fail(502, "Couldn't explain these files. Try again.");
      if (explained.tokens) console.log(`[explain] tokens in=${explained.tokens.in} out=${explained.tokens.out}`);
      if (explained.markdown !== file.content) {
        await githubPut(user.github_token, repo, path, explained.markdown, `where: why and after for ${name}`, file.sha).catch((err: unknown) =>
          console.error("[explain] write failed:", err instanceof Error ? err.message : err),
        );
      }
      return NextResponse.json({ files: explained.files });
    }
    return fail(404, "This capture isn't in your knowledge repo anymore.");
  } catch (err) {
    const github = githubFailure(err);
    if (github) return github;
    return fail(500, `[explain] ${err instanceof Error ? err.message : "Failed to explain the capture"}`);
  }
}
