import { NextRequest, NextResponse } from "next/server";
import { readFileStrict } from "@/lib/github";
import { captureName, parseIndexRows, type CaptureStatus } from "@/lib/captures";
import { parseCaptureFile, type CaptureDetail } from "@/lib/capture-detail";
import { captureFileUrl } from "@/lib/captureFileUrl";
import { fail, githubFailure, repoUser } from "@/lib/captures-route";
import { HANDOFFS_PATH, captureName as handoffCapture, parseHandoffLog, parseHandoffs } from "@/lib/handoffs";
import type { HandoffState } from "@/lib/handoff-status";

const FOLDERS: CaptureStatus[] = ["inbox", "applied", "archived"];

/**
 * One capture for the capture page, as plain fields. The folder comes from its
 * INDEX.md row; without one (an older or hand-moved file) each folder is tried.
 * Its handoffs come from HANDOFFS.md, plus the answers in its Handoff log for
 * repos with no row there; when HANDOFFS.md can't be read the capture still
 * shows, with the logged answers only.
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
        handoffs: withLoggedAnswers(await handoffsOf(user.github_token, repo, name), file.content),
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

/** The capture's HANDOFFS.md rows, as repo, status and since. None when the file is missing or unreadable. */
async function handoffsOf(token: string, repo: string, name: string): Promise<HandoffState[]> {
  try {
    const file = await readFileStrict(token, repo, HANDOFFS_PATH);
    if (!file) return [];
    return parseHandoffs(file.content).rows
      .filter((r) => handoffCapture(r.capture) === name)
      .map((r) => ({ repo: r.repo, status: r.status, since: r.since }));
  } catch {
    return [];
  }
}

/** What the log keeps for good: a repo whose last answer was one of these. */
const LOGGED_FINAL = new Set(["declined", "done", "applied"]);

/**
 * Adds, for each repo with no HANDOFFS.md row, the capture's last logged
 * answer when it's final: a "Not a fit" on a repo that was never queued only
 * goes to the log, and a finished row leaves HANDOFFS.md after a while.
 */
function withLoggedAnswers(rows: HandoffState[], content: string): HandoffState[] {
  const has = new Set(rows.map((r) => r.repo.toLowerCase()));
  const last = new Map<string, HandoffState>();
  for (const e of parseHandoffLog(content)) {
    const repo = e.repo?.toLowerCase();
    if (!repo || has.has(repo)) continue;
    last.delete(repo);
    last.set(repo, { repo, status: e.outcome, since: e.date });
  }
  return [...rows, ...[...last.values()].filter((r) => LOGGED_FINAL.has(r.status))];
}
