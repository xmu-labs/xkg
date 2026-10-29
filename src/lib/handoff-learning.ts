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
import { readFile } from "./github";
import { captureName, markDead, parseHandoffLog, readHandoffs, type HandoffLogEntry } from "./handoffs";

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
    const apply = applies.find((a) => !reverted.has(a) && a.commit && sameCommit(a.commit, r.commit!));
    if (apply) reverted.add(apply);
    const repo = apply?.repo ?? r.repo;
    if (repo) add(repo, ["", ...(apply?.files ?? [])], r.date, -1);
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

async function insertScores(userId: number, key: string, tagKeys: string[], scores: Score[], today: string): Promise<void> {
  if (!scores.length) return;
  await sql`
    INSERT INTO handoff_scores (user_id, capture_key, repo, path, weight, negatives, tag_keys, updated_at)
    SELECT ${userId}, ${key}, r, p, w, n, ${tagKeys}::text[], ${today}
    FROM unnest(${scores.map((s) => s.repo)}::text[], ${scores.map((s) => s.path)}::text[], ${scores.map((s) => s.weight)}::float8[], ${scores.map((s) => s.negatives)}::int[]) AS t(r, p, w, n)
  `;
}

type LearnUser = { id: number; github_token: string; github_repo: string | null };

/**
 * After an answer: replaces the capture's rows with scores from its log (the
 * capture as just written), and marks its HANDOFFS.md rows dead in repos that
 * became a dead end. Best-effort: never throws.
 */
export async function learnFrom(user: LearnUser, path: string, content: string, today: string): Promise<void> {
  try {
    const scores = scoresOf(parseHandoffLog(content), today);
    const key = captureKey(captureName(path));
    await ensureHandoffScoreTable();
    await sql`DELETE FROM handoff_scores WHERE user_id = ${user.id} AND capture_key = ${key}`;
    await insertScores(user.id, key, tagsOf(content).map(tagKey), scores, today);
    const dead = scores.filter((s) => !s.path && s.negatives >= DEAD_END).map((s) => s.repo);
    if (dead.length && user.github_repo) await markDead(user.github_token, user.github_repo, path, dead, today);
  } catch (err) {
    console.error("[handoff] learning failed:", err instanceof Error ? err.message : err);
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

/**
 * Makes the user's handoff_scores again from git: every capture with a row in
 * HANDOFFS.md, read from inbox/, applied/ or archived/. Captures whose
 * finished rows were pruned from HANDOFFS.md are left out.
 */
export async function rebuildHandoffIndex(user: LearnUser, today: string): Promise<{ captures: number; rows: number }> {
  if (!user.github_repo) return { captures: 0, rows: 0 };
  const names = [...new Set((await readHandoffs(user.github_token, user.github_repo)).map((r) => captureName(r.capture)))];
  await ensureHandoffScoreTable();
  await sql`DELETE FROM handoff_scores WHERE user_id = ${user.id}`;
  let captures = 0;
  let rows = 0;
  for (const name of names) {
    let content: string | null = null;
    for (const dir of ["inbox", "applied", "archived"]) {
      content = (await readFile(user.github_token, user.github_repo, `${dir}/${name}`))?.content ?? null;
      if (content) break;
    }
    if (!content) continue;
    const scores = scoresOf(parseHandoffLog(content), today);
    await insertScores(user.id, captureKey(name), tagsOf(content).map(tagKey), scores, today);
    captures++;
    rows += scores.length;
  }
  return { captures, rows };
}
