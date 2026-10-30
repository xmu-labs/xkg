import { NextRequest, NextResponse } from "next/server";
import { readFile } from "@/lib/github";
import { parseIndexRows } from "@/lib/captures";
import { fail, repoUser } from "@/lib/captures-route";

const STATUSES = new Set(["inbox", "applied", "archived"]);

/** The captures page list: INDEX.md rows, newest first, optionally one folder. GET /api/captures?status=inbox */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const user = await repoUser();
    if (user instanceof NextResponse) return user;
    const index = await readFile(user.github_token, user.github_repo!, "INDEX.md");
    const rows = index ? parseIndexRows(index.content) : [];
    const status = req.nextUrl.searchParams.get("status");
    const captures = status && STATUSES.has(status) ? rows.filter((r) => r.status === status) : rows;
    return NextResponse.json({ captures });
  } catch (err) {
    return fail(500, `[captures] ${err instanceof Error ? err.message : "Failed to list captures"}`);
  }
}
