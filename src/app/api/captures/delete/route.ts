import { NextRequest, NextResponse } from "next/server";
import { captureName, deleteCapture } from "@/lib/captures";
import { fail, jsonBody, repoUser } from "@/lib/captures-route";

/** The captures page's Delete button. Body: { filename } of an inbox capture. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const user = await repoUser();
    if (user instanceof NextResponse) return user;
    const body = await jsonBody(req);
    if (!body) return fail(400, "Body must be JSON.");
    const filename = captureName(body.filename);
    if (!filename) return fail(400, "Name a capture file, like 2026-10-28-slug.md.");
    if (!(await deleteCapture(user, filename))) return fail(404, "That capture isn't in your inbox anymore.");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fail(500, `[delete] ${err instanceof Error ? err.message : "Failed to delete the capture"}`);
  }
}
