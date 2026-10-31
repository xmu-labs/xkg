import { NextRequest, NextResponse } from "next/server";
import { readFileStrict } from "@/lib/github";
import { captureName, parseIndexRows, type CaptureStatus } from "@/lib/captures";
import { parseCaptureFile, type CaptureDetail } from "@/lib/capture-detail";
import { captureFileUrl } from "@/lib/captureFileUrl";
import { fail, githubFailure, repoUser } from "@/lib/captures-route";

const FOLDERS: CaptureStatus[] = ["inbox", "applied", "archived"];

/**
 * One capture for the capture page, as plain fields. The folder comes from its
 * INDEX.md row; without one (an older or hand-moved file) each folder is tried.
 * GET /api/captures/read?name=2026-10-30-slug.md
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const user = await repoUser();
    if (user instanceof NextResponse) return user;
    const name = captureName(req.nextUrl.searchParams.get("name"));
    if (!name) return fail(400, "That capture name isn't valid.");

    const repo = user.github_repo!;
    const index = await readFileStrict(user.github_token, repo, "INDEX.md");
    const rows = index ? parseIndexRows(index.content) : [];
    const listed = rows.find((r) => r.filename === name)?.status;

    for (const folder of listed ? [listed, ...FOLDERS.filter((f) => f !== listed)] : FOLDERS) {
      const file = await readFileStrict(user.github_token, repo, `${folder}/${name}`);
      if (!file) continue;
      const fields = parseCaptureFile(file.content);
      const summaries = new Map(rows.map((r) => [r.filename, r.summary]));
      const capture: CaptureDetail = {
        ...fields,
        links: fields.links.map((l) => ({ ...l, summary: summaries.get(l.name) ?? null })),
        filename: name,
        status: folder,
        fileUrl: captureFileUrl(repo, name, folder),
      };
      return NextResponse.json({ capture });
    }
    return fail(404, "This capture isn't in your knowledge repo anymore.");
  } catch (err) {
    const github = githubFailure(err);
    if (github) return github;
    return fail(500, `[captures/read] ${err instanceof Error ? err.message : "Failed to read the capture"}`);
  }
}
