import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import type { User } from "@/lib/db";
import { GitHubReadError } from "@/lib/github";

/** Shared guards for the web app's captures routes. */

export function fail(status: number, error: string, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json({ error }, { status, headers });
}

/** The signed-in user with a knowledge repo, or the response to send instead. */
export async function repoUser(): Promise<User | NextResponse> {
  const user = await getSession();
  if (!user) return fail(401, "Not authenticated");
  if (!user.github_repo) return fail(400, "Knowledge repo not configured. Complete onboarding first.");
  return user;
}

/** The response for a failed GitHub read, or null when `err` is something else. */
export function githubFailure(err: unknown): NextResponse | null {
  if (!(err instanceof GitHubReadError)) return null;
  return fail(502, `Couldn't read your knowledge repo on GitHub (HTTP ${err.status ?? "error"}). Try again in a moment.`);
}

/** The JSON body as an object, or null when it isn't one. */
export async function jsonBody(req: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
