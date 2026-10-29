/**
 * Learning from handoff answers, with no model. Each capture's `## Handoff
 * log` (git, the source of truth) becomes signals per capture × file and per
 * capture × repo:
 *
 *   applied            +1 per changed file, +1 for the repo (once per commit)
 *   declined           wrong-files: -1 per suggested file · doesnt-fit: -1 for the repo
 *   reverted           the apply's +1s are cancelled, then -1 per file and for the repo
 *   later, done, expired  nothing
 *
 * A signal halves every 30 days. Two negatives (counted, not weighed) make a
 * dead end: the file isn't handed off for that capture again, and a repo
 * isn't offered again (its HANDOFFS.md row becomes dead). A file applied for
 * two captures that share a tag, with weight over 0.5, is proven for that
 * tag: Jev also rates it for new captures with the tag (where.ts).
 *
 * handoff_scores is a cache of the logs, keyed and tagged by hash only;
 * rebuildHandoffIndex makes it again from git.
 */

import crypto from "crypto";
import { sql } from "./sql";
import { env } from "./env";
import { ensureHandoffScoreTable } from "./db";
import { captureKey } from "./apply-events";
import { githubGet } from "./github";
import { captureName, HANDOFFS_PATH, markDead, parseHandoffLog, parseHandoffs, type HandoffLogEntry } from "./handoffs";

export const HALF_LIFE_DAYS = 30;
/** Negatives that make a capture × file or capture × repo a dead end. */
export const DEAD_END = 2;
/** Captures, sharing a tag, whose applies changed a file before it's proven for that tag. */
export const PROVEN_CAPTURES = 2;
export const PROVEN_WEIGHT = 0.5;

/** A capture's score on one file, or on a repo when `path` is "". */
export interface Score {
  repo: string;
  path: string;
  weight: number;
  negatives: number;
}

const DAY_MS = 86_400_000;
const days = (from: string, to: string) => Math.max(0, (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** `weight` as of `from`, weighed on `to`. */
export function decayed(weight: number, from: string, to: string): number {
  return weight * 0.5 ** (days(from, to) / HALF_LIFE_DAYS);
}

const sameCommit = (a: string, b: string) => {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return x.startsWith(y) || y.startsWith(x);
};

/** The capture's scores on `today`, from its Handoff log. */
export function scoresOf(entries: HandoffLogEntry[], today: string): Score[] {
  const lines = new Set<string>();
  const applies: HandoffLogEntry[] = [];
  const reverts: HandoffLogEntry[] = [];
  const declines: HandoffLogEntry[] = [];
  for (const e of entries) {
    // The same answer twice on one day (a retried call) counts once
    const line = JSON.stringify([e.date, e.repo?.toLowerCase(), e.outcome, e.reason, e.commit, e.files]);
    if (lines.has(line)) continue;
    lines.add(line);
    if (e.outcome === "applied" && e.repo) {
      // The hook and the agent may both report one commit
      if (e.commit && applies.some((a) => a.commit && a.repo!.toLowerCase() === e.repo!.toLowerCase() && sameCommit(a.commit, e.commit!))) continue;
      applies.push(e);
    } else if (e.outcome === "reverted" && e.commit) reverts.push(e);
    else if (e.outcome === "declined" && e.repo) declines.push(e);
  }

  const signals: { repo: string; path: string; date: string; value: number }[] = [];
  const add = (repo: string, paths: string[], date: string, value: number) => {
    for (const path of paths) signals.push({ repo: repo.toLowerCase(), path, date, value });
  };
  const reverted = new Set<HandoffLogEntry>();
  for (const r of reverts) {
    // The apply of that commit in the repo the revert names (an upstream and its fork share commits)
    const apply = applies.find((a) => !reverted.has(a) && a.commit && sameCommit(a.commit, r.commit!) && (!r.repo || a.repo!.toLowerCase() === r.repo.toLowerCase()));
    if (apply) reverted.add(apply);
    const repo = apply?.repo ?? r.repo;
    // The apply's files, or the revert's own when the apply named none (or wasn't logged)
    const files = apply?.files?.length ? apply.files : (r.files ?? []);
    if (repo) add(repo, ["", ...files], r.date, -1);
  }
  for (const a of applies) if (!reverted.has(a)) add(a.repo!, ["", ...(a.files ?? [])], a.date, 1);
  for (const d of declines) {
    if (d.reason === "wrong-files") add(d.repo!, d.files ?? [], d.date, -1);
    else if (d.reason === "doesnt-fit") add(d.repo!, [""], d.date, -1);
  }

  const scores = new Map<string, Score>();
  for (const s of signals) {
    const key = `${s.repo}\n${s.path}`;
    const score = scores.get(key) ?? { repo: s.repo, path: s.path, weight: 0, negatives: 0 };
    score.weight += decayed(s.value, s.date, today);
    if (s.value < 0) score.negatives++;
    scores.set(key, score);
  }
  return [...scores.values()].sort((a, b) => a.repo.localeCompare(b.repo) || a.path.localeCompare(b.path));
}

/** A tag as stored: a keyed hash, like captureKey, so the index never holds the user's words. */
export function tagKey(tag: string): string {
  return crypto.createHmac("sha256", env.sessionSecret).update(`handoff-tag:${tag.trim().toLowerCase()}`).digest("hex").slice(0, 32);
}

/** The capture's tags, from its frontmatter. */
function tagsOf(content: string): string[] {
  const line = content.match(/^tags:\s*(.+)$/m)?.[1] ?? "";
  return [...new Set(line.split(",").map((t) => t.trim()).filter(Boolean))];
}

export interface ScoreRow extends Score {
  captureKey: string;
  tagKeys: string[];
  /** The day `weight` was computed for (YYYY-MM-DD). */
  updatedAt: string;
}

export interface ProvenFile {
  tagKey: string;
  repo: string;
  path: string;
  captures: number;
  weight: number;
}

/**
 * Files proven for any of these tags: changed by applies of PROVEN_CAPTURES
 * captures with the tag, each still positive and not a dead end for it, with
 * a weight over PROVEN_WEIGHT on `today`. One entry per file, its best tag.
 */
export function provenFiles(rows: ScoreRow[], tagKeys: string[], today: string): ProvenFile[] {
  const best = new Map<string, ProvenFile>();
  for (const key of tagKeys) {
    const byFile = new Map<string, ScoreRow[]>();
    for (const r of rows) {
      if (!r.path || !r.tagKeys.includes(key) || r.negatives >= DEAD_END || decayed(r.weight, r.updatedAt, today) <= 0) continue;
      const file = `${r.repo}\n${r.path}`;
      byFile.set(file, [...(byFile.get(file) ?? []), r]);
    }
    for (const [file, mine] of byFile) {
      const captures = new Set(mine.map((r) => r.captureKey)).size;
      const weight = Number(mine.reduce((sum, r) => sum + decayed(r.weight, r.updatedAt, today), 0).toFixed(4));
      if (captures < PROVEN_CAPTURES || weight <= PROVEN_WEIGHT) continue;
      const seen = best.get(file);
      if (!seen || weight > seen.weight) best.set(file, { tagKey: key, repo: mine[0]!.repo, path: mine[0]!.path, captures, weight });
    }
  }
  return [...best.values()];
}

/** A capture's scores as learned from its log, ready to store. */
interface CaptureScores {
  key: string;
  tagKeys: string[];
  scores: Score[];
  /** The size of the Handoff log the scores came from. */
  entries: number;
}

/**
 * Replaces these captures' rows in one statement, so a failed write leaves
 * the old rows. Each row keeps the size of the log it came from, and a log
 * only grows: when two writes for a capture land together, the one from the
 * shorter log never replaces the other's (the upsert waits for its row locks).
 * Other captures' rows are left as they are.
 */
async function replaceScores(userId: number, captures: CaptureScores[], today: string): Promise<void> {
  const rows = captures.flatMap((c) => c.scores.map((s) => ({ ...s, key: c.key, tags: c.tagKeys.join(",") })));
  await sql`
    WITH caps AS (
      SELECT k, e FROM unnest(${captures.map((c) => c.key)}::text[], ${captures.map((c) => c.entries)}::int[]) AS t(k, e)
    ), incoming AS (
      SELECT k, r, p, w, n, string_to_array(t, ',') AS tags
      FROM unnest(${rows.map((r) => r.key)}::text[], ${rows.map((r) => r.repo)}::text[], ${rows.map((r) => r.path)}::text[], ${rows.map((r) => r.weight)}::float8[], ${rows.map((r) => r.negatives)}::int[], ${rows.map((r) => r.tags)}::text[]) AS t(k, r, p, w, n, t)
    ), gone AS (
      DELETE FROM handoff_scores s USING caps c WHERE s.user_id = ${userId} AND s.capture_key = c.k AND s.log_entries <= c.e
        AND NOT EXISTS (SELECT 1 FROM incoming i WHERE i.k = s.capture_key AND i.r = s.repo AND i.p = s.path)
    )
    INSERT INTO handoff_scores (user_id, capture_key, repo, path, weight, negatives, tag_keys, updated_at, log_entries)
    SELECT ${userId}, i.k, i.r, i.p, i.w, i.n, i.tags, ${today}::date, c.e FROM incoming i JOIN caps c ON c.k = i.k
    WHERE NOT EXISTS (SELECT 1 FROM handoff_scores s WHERE s.user_id = ${userId} AND s.capture_key = i.k AND s.log_entries > c.e)
    ON CONFLICT (user_id, capture_key, repo, path) DO UPDATE
      SET weight = EXCLUDED.weight, negatives = EXCLUDED.negatives, tag_keys = EXCLUDED.tag_keys, updated_at = EXCLUDED.updated_at, log_entries = EXCLUDED.log_entries
      WHERE handoff_scores.log_entries <= EXCLUDED.log_entries
  `;
}

/** The capture's scores from its content (the capture file as written). */
function capturedScores(name: string, content: string, today: string): CaptureScores {
  const entries = parseHandoffLog(content);
  return { key: captureKey(name), tagKeys: tagsOf(content).map(tagKey), scores: scoresOf(entries, today), entries: entries.length };
}

type LearnUser = { id: number; github_token: string; github_repo: string | null };

/**
 * After an answer: replaces the capture's rows with scores from its log (the
 * capture as just written), and marks its HANDOFFS.md rows dead in repos that
 * became a dead end. Best-effort: never throws.
 */
export async function learnFrom(user: LearnUser, path: string, content: string, today: string): Promise<void> {
  try {
    const { scores, ...learned } = capturedScores(captureName(path), content, today);
    await ensureHandoffScoreTable();
    await replaceScores(user.id, [{ ...learned, scores }], today);
    const dead = scores.filter((s) => !s.path && s.negatives >= DEAD_END).map((s) => s.repo);
    if (dead.length && user.github_repo) await markDead(user.github_token, user.github_repo, path, dead, today);
  } catch (err) {
    console.error("[handoff] learning failed:", err instanceof Error ? err.message : err);
  }
}

/** Drops a deleted capture's rows, so a new capture with its name starts fresh. Best-effort: never throws. */
export async function forgetCapture(userId: number, filename: string): Promise<void> {
  try {
    await ensureHandoffScoreTable();
    await sql`DELETE FROM handoff_scores WHERE user_id = ${userId} AND capture_key = ${captureKey(captureName(filename))}`;
  } catch (err) {
    console.error("[handoff] forgetting a capture failed:", err instanceof Error ? err.message : err);
  }
}

/** The capture's files that are dead ends in `repo`. Empty when nothing was learned or the database can't be read. */
export async function deadEnds(userId: number, filename: string, repo: string): Promise<Set<string>> {
  try {
    await ensureHandoffScoreTable();
    const { rows } = await sql<{ path: string }>`
      SELECT path FROM handoff_scores
      WHERE user_id = ${userId} AND capture_key = ${captureKey(captureName(filename))} AND repo = ${repo.toLowerCase()} AND path <> '' AND negatives >= ${DEAD_END}
    `;
    return new Set(rows.map((r) => r.path));
  } catch (err) {
    console.error("[handoff] dead ends read failed:", err instanceof Error ? err.message : err);
    return new Set();
  }
}

export interface Proven {
  /** The new capture's own tag that the file is proven for. */
  tag: string;
  repo: string;
  path: string;
  captures: number;
  weight: number;
}

/** Files proven for any of a new capture's tags. Empty when nothing was learned or the database can't be read. */
export async function provenFor(userId: number, tags: string[], today: string): Promise<Proven[]> {
  const byKey = new Map(tags.map((t) => [tagKey(t), t]));
  if (!byKey.size) return [];
  try {
    await ensureHandoffScoreTable();
    const { rows } = await sql<{ capture_key: string; tag_keys: string[]; repo: string; path: string; weight: number; negatives: number; updated_at: string }>`
      SELECT capture_key, tag_keys, repo, path, weight, negatives, to_char(updated_at, 'YYYY-MM-DD') AS updated_at FROM handoff_scores
      WHERE user_id = ${userId} AND path <> '' AND weight > 0 AND tag_keys && ${[...byKey.keys()]}::text[]
    `;
    const scored: ScoreRow[] = rows.map((r) => ({
      captureKey: r.capture_key, tagKeys: r.tag_keys, repo: r.repo, path: r.path, weight: Number(r.weight), negatives: Number(r.negatives), updatedAt: r.updated_at,
    }));
    return provenFiles(scored, [...byKey.keys()], today).map(({ tagKey: key, ...p }) => ({ tag: byKey.get(key)!, ...p }));
  } catch (err) {
    console.error("[handoff] proven files read failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

/** A file's content, or null when it doesn't exist. Throws on any other GitHub answer, so a failed read is never taken for a missing file. */
async function readOrThrow(token: string, repo: string, path: string): Promise<string | null> {
  const res = await githubGet<{ content: string }>(token, repo, path);
  if (res.status === 404) return null;
  if (!res.ok || !res.data) throw new Error(`GitHub GET ${path}: HTTP ${res.status}`);
  return Buffer.from(res.data.content.replace(/\n/g, ""), "base64").toString("utf-8");
}

/**
 * Makes the user's handoff_scores again from git for every capture with a
 * row in HANDOFFS.md, read from inbox/, applied/ or archived/. Everything is
 * read first, so a failed GitHub read throws and leaves the index as it was,
 * and the rows are then replaced in one statement. A capture learned from a
 * longer log while the rebuild ran keeps those rows. Rows of captures it
 * didn't read (pruned from HANDOFFS.md, or whose file is gone) are kept.
 */
export async function rebuildHandoffIndex(user: LearnUser, today: string): Promise<{ captures: number; rows: number }> {
  if (!user.github_repo) return { captures: 0, rows: 0 };
  const handoffs = await readOrThrow(user.github_token, user.github_repo, HANDOFFS_PATH);
  const names = [...new Set((handoffs ? parseHandoffs(handoffs).rows : []).map((r) => captureName(r.capture)))];
  const rebuilt: CaptureScores[] = [];
  for (const name of names) {
    let content: string | null = null;
    for (const dir of ["inbox", "applied", "archived"]) {
      content = await readOrThrow(user.github_token, user.github_repo, `${dir}/${name}`);
      if (content) break;
    }
    if (content) rebuilt.push(capturedScores(name, content, today));
  }

  await ensureHandoffScoreTable();
  if (rebuilt.length) await replaceScores(user.id, rebuilt, today);
  return { captures: rebuilt.length, rows: rebuilt.reduce((n, c) => n + c.scores.length, 0) };
}
