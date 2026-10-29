import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { deleteCodeMap, listCodeRepos, saveCodeMap } from "@/lib/db";
import { consumeQuota } from "@/lib/rate-limit";
import { CODE_MAP_QUOTA } from "@/lib/code-map";
import { codeMapHash, fetchGithubMap, repoName } from "@/lib/code-repos";

/**
 * Settings → Code repos: list the user's repos, add one by reading its file
 * paths from GitHub with the user's own sign-in, or remove one.
 */

function fail(status: number, error: string, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json({ error }, { status, headers });
}

async function repos(userId: number): Promise<NextResponse> {
  return NextResponse.json({ repos: await listCodeRepos(userId) });
}

async function repoFrom(req: NextRequest): Promise<string | null> {
  try {
    const body = (await req.json()) as { repo?: unknown };
    return typeof body?.repo === "string" ? repoName(body.repo) : null;
  } catch {
    return null;
  }
}

export async function GET(): Promise<NextResponse> {
  try {
    const user = await getSession();
    if (!user) return fail(401, "Not authenticated");
    return await repos(user.id);
  } catch (err) {
    return fail(500, `[code-repos] ${err instanceof Error ? err.message : "Failed to list repos"}`);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const user = await getSession();
    if (!user) return fail(401, "Not authenticated");
    const repo = await repoFrom(req);
    if (!repo) return fail(400, "Enter the repo as owner/name, for example acme/widgets.");

    const quota = await consumeQuota(`code-map:user:${user.id}`, CODE_MAP_QUOTA);
    if (!quota.allowed) {
      return fail(429, `Rate limit reached: ${quota.limit} map syncs per hour.`, { "Retry-After": String(quota.resetIn) });
    }

    const fetched = await fetchGithubMap(user.github_token, repo);
    if (!fetched.ok) return fail(400, fetched.error);
    if (!(await saveCodeMap(user.id, fetched.map, codeMapHash(fetched.map), "github"))) {
      return fail(409, `${repo} already has a map from your machine, which also has its exported names. Nothing changed.`);
    }
    return await repos(user.id);
  } catch (err) {
    return fail(500, `[code-repos] ${err instanceof Error ? err.message : "Failed to add the repo"}`);
  }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  try {
    const user = await getSession();
    if (!user) return fail(401, "Not authenticated");
    const repo = await repoFrom(req);
    if (!repo) return fail(400, "Enter the repo as owner/name, for example acme/widgets.");
    if (!(await deleteCodeMap(user.id, repo))) return fail(404, `No code repo named ${repo}.`);
    return await repos(user.id);
  } catch (err) {
    return fail(500, `[code-repos] ${err instanceof Error ? err.message : "Failed to remove the repo"}`);
  }
}
