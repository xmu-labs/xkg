/**
 * Captures as the web app sees them: the INDEX.md rows, and the human actions
 * on them (archive, delete, check links, weekly applies). The MCP handlers for
 * the same actions call these, so the web app and an agent change the
 * knowledge repo the same way.
 */

import type { User } from "@/lib/db";
import { GitHubReadError, githubDelete, githubGet, githubPut, readFileStrict, updateIndexEntry } from "@/lib/github";
import { forgetCapture } from "@/lib/handoff-learning";
import { safeFetch } from "@/lib/fetch-source";
import { curateSingle, filterByDateRange, paginate, type PageResult } from "@/lib/llm";
import { LEDGER_PATH, weeklyApplyStats, type WeekStats } from "@/lib/ledger";

export type CaptureStatus = "inbox" | "applied" | "archived";

export type CaptureRow = {
  date: string;
  slug: string;
  filename: string;
  status: CaptureStatus;
  summary: string;
  tags: string[];
  type: string | null;
};

const ROW_LINK = /\[([^\]]*)\]\((inbox|applied|archived)\/([^)]+)\)/;

/**
 * A table row's cells. A backslash escapes a following backslash or pipe, so
 * an escaped pipe stays inside its cell; any other backslash is kept as written.
 */
function rowCells(line: string): string[] {
  const text = line.trim().replace(/^\|/, "");
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === "\\" && (next === "\\" || next === "|")) {
      cell += next;
      i++;
    } else if (ch === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell.trim()) cells.push(cell.trim());
  return cells;
}

/** The capture rows of INDEX.md, newest first. Rows that don't link a capture are skipped. */
export function parseIndexRows(content: string): CaptureRow[] {
  const rows: CaptureRow[] = [];
  for (const line of content.split("\n")) {
    const cells = rowCells(line);
    const date = cells[0] ?? "";
    const link = cells[1]?.match(ROW_LINK);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !link) continue;
    // Older rows were written with bare pipes in the summary. The writer always
    // ends the summary with "...", so the summary runs to that cell.
    let end = 2;
    for (let i = cells.length - 2; i > 2; i--) {
      if (cells[i]!.endsWith("...")) { end = i; break; }
    }
    const typeCell = cells[end + 2];
    rows.push({
      date,
      slug: link[1]!,
      filename: link[3]!,
      status: link[2] as CaptureStatus,
      summary: cells.slice(2, end + 1).join(" | ").replace(/\.\.\.$/, ""),
      tags: (cells[end + 1] ?? "").split(",").map((t) => t.trim()).filter(Boolean),
      type: typeCell && typeCell !== "—" ? typeCell : null,
    });
  }
  return rows.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * A bare capture filename (`2026-10-28-slug.md`), or null for anything else.
 * Slugs come from the model and may hold accents or non-Latin letters, so any
 * letter or number is allowed; what's refused is anything that could leave the
 * folder (separators, `..`, a leading dot) or break a path (spaces, controls).
 */
export function captureName(value: unknown): string | null {
  if (typeof value !== "string" || !/^[\p{L}\p{N}_-][\p{L}\p{N}\p{M}_.-]*\.md$/u.test(value) || value.includes("..")) return null;
  return value;
}

/** Moves an inbox capture to archived/. False when it isn't in the inbox. */
export async function archiveCapture(user: User, filename: string): Promise<boolean> {
  if (!user.github_repo) return false;
  const inboxPath = `inbox/${filename}`;
  const file = await readFileStrict(user.github_token, user.github_repo, inboxPath);
  if (!file) return false;

  const content = file.content.replace(/^status:\s*inbox$/m, "status: archived");
  await githubPut(user.github_token, user.github_repo, `archived/${filename}`, content, `archive: ${filename}`);
  await githubDelete(user.github_token, user.github_repo, inboxPath, file.sha, `archive: remove ${filename} from inbox`);
  await updateIndexEntry(user.github_token, user.github_repo, filename, "archive");
  return true;
}

/** Deletes an inbox capture, its index row and what handoffs learned about it. False when it isn't in the inbox. */
export async function deleteCapture(user: User, filename: string): Promise<boolean> {
  if (!user.github_repo) return false;
  const inboxPath = `inbox/${filename}`;
  const file = await readFileStrict(user.github_token, user.github_repo, inboxPath);
  if (!file) return false;

  await githubDelete(user.github_token, user.github_repo, inboxPath, file.sha, `delete: ${filename}`);
  await updateIndexEntry(user.github_token, user.github_repo, filename, "delete");
  await forgetCapture(user.id, filename);
  return true;
}

export type LinkCheck = {
  filename: string;
  status: "ok" | "stale" | "low_confidence" | "stale_and_low_confidence" | "not_found";
  httpStatus: number | null;
  reason: string;
};

/**
 * Liveness check for a capture's source URL. The `url:` frontmatter is
 * attacker-influenced (it comes from LLM extraction of user-supplied
 * content), and the returned status is echoed back to the caller, so an
 * unguarded fetch here is an SSRF with a status oracle. Reuse the same
 * redirect-validating guard the capture path uses.
 */
async function urlStatus(url: string): Promise<number | null> {
  const res = await safeFetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) });
  return res?.status ?? null;
}

/** Checks one inbox capture: is its source still there, and was the extraction confident? */
export async function checkCapture(user: User, filename: string): Promise<LinkCheck> {
  const file = user.github_repo ? await readFileStrict(user.github_token, user.github_repo, `inbox/${filename}`) : null;
  if (!file) return { filename, status: "not_found", httpStatus: null, reason: "File not found in inbox." };

  const fm = file.content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const urlField = fm.match(/^url:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const url = urlField && urlField !== "none" ? urlField : null;
  const isLowConfidence = /^lowConfidence:\s*true$/m.test(fm);

  const httpStatus = url ? await urlStatus(url) : null;
  return { filename, httpStatus, ...curateSingle(httpStatus, isLowConfidence) };
}

/**
 * One page of inbox capture names, date-sorted (filenames are date-prefixed),
 * within an optional date window. Null when the inbox is empty; `inInbox` is
 * the count before the window.
 */
export async function inboxPage(
  user: User,
  args: { since?: string; until?: string; offset?: number; limit?: number },
  defaultLimit: number,
): Promise<{ page: PageResult<{ name: string }>; inInbox: number } | null> {
  if (!user.github_repo) return null;
  const res = await githubGet<Array<{ name: string }>>(user.github_token, user.github_repo, "inbox");
  if (res.status === 404) return null;
  if (!res.ok || !res.data) throw new GitHubReadError("inbox", res.status);
  const allMd = res.data.filter((f) => f.name.endsWith(".md")).sort((a, b) => a.name.localeCompare(b.name));
  if (allMd.length === 0) return null;
  const filtered = filterByDateRange(allMd, args.since, args.until);
  return { page: paginate(filtered, args.offset ?? 0, args.limit ?? defaultLimit), inInbox: allMd.length };
}

/** Captures applied per week, newest first, from the APPLIED.md ledger; null when nothing was applied yet. */
export async function applyStats(user: User, weeks: number): Promise<WeekStats[] | null> {
  if (!user.github_repo) return null;
  const ledger = await readFileStrict(user.github_token, user.github_repo, LEDGER_PATH);
  if (!ledger) return null;
  return weeklyApplyStats(ledger.content, new Date().toISOString().slice(0, 10), weeks);
}

/** A weeks count clamped to 1..52, 4 when unset. */
export function clampWeeks(value: unknown): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), 52) : 4;
}
