import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import type { User } from "@/lib/db";

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

/** The JSON body as an object, or null when it isn't one. */
export async function jsonBody(req: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
