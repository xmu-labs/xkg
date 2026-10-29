/**
 * "Where it applies": at capture, xkg finds the repo and up to 3 files where
 * the capture would change something, from the user's code maps (file and
 * function names, never code).
 *
 * With xkg's TypeSafe key set, Jev decides: it rates the name ranker's top
 * files per repo, and the user's model is not called. Otherwise, or when Jev
 * fails, one call to the user's model picks the files; xkg then checks every
 * path against the stored map, drops reasons that name functions the file
 * doesn't export, and takes the tier from a scorer, never from the model's own
 * confidence.
 *
 * Never throws: any failure returns null and the capture is saved as before.
 */

import type { MapFile, StoredCodeMap } from "./code-map";
import { refreshStaleGithubMaps } from "./code-repos";
import { listCodeMaps, type User } from "./db";
import { env } from "./env";
import { githubPut, readFile } from "./github";
import { provenFor, type Proven } from "./handoff-learning";
import { jevScorer } from "./jev";
import { callLlm, llmSettings, type LlmUsage } from "./llm";
import type { ExtractedCapture } from "./types";
import { rankFiles, renderMaps, sharedNames, type RankedFile } from "./where-rank";
import { evidenceScorer, tierOf, type CaptureText, type Candidate, type Scorer, type Tier } from "./where-score";

export type { StoredCodeMap };

/** Maps of this many most recently synced repos go into one match. */
export const MATCH_REPOS = 5;
const MAX_FILES = 3;
/** Files per repo, best ranked first, that Jev rates. */
export const JEV_POOL = 15;
const MAX_WHY_WORDS = 20;
const FRESH_DAYS = 14;

/** "unreadable": the model replied but the reply couldn't be read; kept only to log the call's cost, never shown. */
export type NoFitReason = "no-maps" | "stale" | "truncated" | "no-shared-words" | "weak" | "unreadable";

export interface WhereResult {
  repo: string | null;
  tier: Tier;
  files: { path: string; why?: string }[];
  also: { repo: string; tier: Tier }[];
  /** The chosen repo's map: sync date (YYYY-MM-DD) and commit. */
  map?: { date: string; head7: string | null };
  noFit?: { reason: NoFitReason; repo?: string };
  /** Which scorer set the tier. */
  scorer: string;
  /** The model's own confidence: logged only, never shown or used. */
  modelConf: number | null;
  /** Tokens the matching call used, when it was made (null: the provider sent no count). */
  tokens?: { in: number | null; out: number | null };
}

/** What the capture card shows: labels only, never a number. */
export interface WhereCard {
  fit: string;
  repo: string | null;
  files: { path: string; why?: string }[];
  also: { repo: string; fit: string }[];
  note: string;
}

export interface WhereDeps {
  listMaps?: (userId: number) => Promise<StoredCodeMap[]>;
  complete?: (system: string, prompt: string, onUsage?: (usage: LlmUsage) => void) => Promise<string>;
  scorer?: Scorer;
  /** Decides instead of the model when set; null: always the model. Defaults to Jev when xkg's TypeSafe key is set. */
  jev?: Scorer | null;
  /** Files proven for any of these tags by earlier applies (handoff-learning.ts); Jev also rates them. */
  proven?: (tags: string[]) => Promise<Proven[]>;
  now?: () => Date;
}

type MatchUser = Pick<User, "id" | "llm_api_key" | "llm_provider" | "llm_model" | "llm_effort"> & Partial<Pick<User, "github_token">>;

export const PROVENANCE = "from file names, not yet checked in your code";
const FIT_LABEL: Record<Tier, string> = { strong: "Strong fit", possible: "Possible fit", none: "No clear fit" };

const SYSTEM = `You match a saved piece of outside knowledge (a capture) to the user's code. You see only maps of the user's repos: file paths, the names each file exports, and the mapped files it imports. You never see code.

Pick the one repo where the capture applies best, and up to ${MAX_FILES} files in it where applying it would change something. Use only repos and paths from the maps. For each file, say in ${MAX_WHY_WORDS} words or fewer why it applies; put in backticks only names that file exports. List other repos it also fits, if any.

Return ONLY valid JSON, no markdown:
{"repo":"owner/name","files":[{"path":"...","why":"..."}],"confidence":0.0,"also":[{"repo":"owner/name"}]}
If nothing fits, return {"repo":null,"reason":"..."}`;

function captureText(c: ExtractedCapture): CaptureText {
  return { title: c.inferredTitle, coreIdea: c.coreIdea, takeaways: c.takeaways };
}

function prompt(maps: string, c: ExtractedCapture): string {
  // Maps first: a repeat match against the same maps reuses the cached prefix.
  return `CODE MAPS:
${maps}
CAPTURE:
Title: ${c.inferredTitle}
Core idea: ${c.coreIdea}
Takeaways:
${c.takeaways.map((t) => `- ${t}`).join("\n")}`;
}

function parseReply(raw: string): unknown {
  const text = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  for (const candidate of [text, /\{[\s\S]*\}/.exec(text)?.[0]]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next form
    }
  }
  return undefined;
}

const NAME = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;

/**
 * The reason, unless it names (in backticks) an identifier the file doesn't
 * export. Spans that aren't names, or are the file's own path, aren't checked.
 */
export function nameCheck(why: string, file: MapFile): string | undefined {
  const base = file.p.slice(file.p.lastIndexOf("/") + 1);
  for (const [, span] of why.matchAll(/`([^`]+)`/g)) {
    const name = span!.trim().replace(/\(\)$/, "");
    if (name === file.p || name === base || !NAME.test(name)) continue;
    if (!(file.e ?? []).includes(name.split(".")[0]!)) return undefined;
  }
  return why;
}

export interface CheckedWhere {
  repo: string | null;
  files: { path: string; why?: string }[];
  also: string[];
  modelConf: number | null;
}

/** The model's reply reduced to what the maps confirm: a mapped repo, mapped paths (at most 3), mapped also-fits repos. */
export function checkWhere(reply: unknown, maps: StoredCodeMap[]): CheckedWhere {
  const r = (reply && typeof reply === "object" ? reply : {}) as Record<string, unknown>;
  const conf = typeof r.confidence === "number" && r.confidence >= 0 && r.confidence <= 1 ? r.confidence : null;
  const map = maps.find((m) => m.repo === r.repo);
  if (!map) return { repo: null, files: [], also: [], modelConf: conf };

  const byPath = new Map(map.files.map((f) => [f.p, f]));
  const files: CheckedWhere["files"] = [];
  for (const item of Array.isArray(r.files) ? r.files : []) {
    const { path, why } = (item ?? {}) as { path?: unknown; why?: unknown };
    const file = typeof path === "string" ? byPath.get(path) : undefined;
    if (!file || files.some((f) => f.path === file.p)) continue;
    const words = typeof why === "string" ? why.replace(/\s+/g, " ").trim().split(" ").filter(Boolean) : [];
    const kept = words.length ? nameCheck(words.slice(0, MAX_WHY_WORDS).join(" "), file) : undefined;
    files.push(kept ? { path: file.p, why: kept } : { path: file.p });
    if (files.length === MAX_FILES) break;
  }

  const also: string[] = [];
  for (const item of Array.isArray(r.also) ? r.also : []) {
    const repo = typeof item === "string" ? item : (item as { repo?: unknown } | null)?.repo;
    if (typeof repo === "string" && repo !== map.repo && !also.includes(repo) && maps.some((m) => m.repo === repo)) also.push(repo);
  }
  return { repo: map.repo, files, also, modelConf: conf };
}

/** Why a match found nothing, from the repo it would most likely have been: an old map first, then a cut-short map, else a weak match. */
function noFitOf(map: StoredCodeMap, fresh: (m: StoredCodeMap) => boolean): { reason: NoFitReason; repo: string } {
  if (!fresh(map)) return { reason: "stale", repo: map.repo };
  if (map.truncated) return { reason: "truncated", repo: map.repo };
  return { reason: "weak", repo: map.repo };
}

export async function matchCapture(user: MatchUser, capture: ExtractedCapture, deps: WhereDeps = {}): Promise<WhereResult | null> {
  if (capture.lowConfidence || !capture.coreIdea?.trim() || !user.llm_api_key) return null;
  const apiKey = user.llm_api_key;
  const scorer = deps.scorer ?? evidenceScorer;
  // A repo added from GitHub is read again here when its names are a week old.
  const listMaps = deps.listMaps ?? (async (id: number) => refreshStaleGithubMaps(user.github_token, id, await listCodeMaps(id, MATCH_REPOS)));
  const complete =
    deps.complete ??
    ((system: string, text: string, onUsage?: (usage: LlmUsage) => void) =>
      callLlm({ llm: llmSettings(user), apiKey, system, user: text, maxTokens: 600, onUsage }));
  const now = (deps.now ?? (() => new Date()))();
  const fresh = (m: StoredCodeMap) => now.getTime() - m.syncedAt.getTime() <= FRESH_DAYS * 86_400_000;
  const jev = deps.jev === undefined ? defaultJev() : deps.jev;
  let tokens: WhereResult["tokens"];
  const none = (noFit: WhereResult["noFit"], modelConf: number | null = null, by = scorer): WhereResult => ({
    repo: null,
    tier: "none",
    files: [],
    also: [],
    noFit,
    scorer: by.name,
    modelConf,
    ...(tokens ? { tokens } : {}),
  });

  try {
    const maps = await listMaps(user.id);
    if (!maps.length) return none({ reason: "no-maps" });

    const text = captureText(capture);
    const query = [text.title, text.coreIdea, ...text.takeaways].join("\n");
    const ranked = rankFiles(maps, query);
    const mapOf = (repo: string) => maps.find((m) => m.repo === repo)!;
    // Files proven for the capture's tags, in the maps: Jev rates them even when no name matches
    const today = now.toISOString().slice(0, 10);
    const proven = jev
      ? (await (deps.proven ?? ((tags: string[]) => provenFor(user.id, tags, today)))(capture.tags ?? []).catch(() => [])).filter((p) =>
          maps.some((m) => m.repo === p.repo && m.files.some((f) => f.p === p.path)),
        )
      : [];
    if (!ranked.length && !proven.length) return none({ reason: "no-shared-words" });
    const noFitFromRanked = () => (ranked.length ? noFitOf(mapOf(ranked[0]!.repo), fresh) : { reason: "no-shared-words" as const });

    if (jev) {
      try {
        const decided = await decideWithJev(jev, maps, ranked, text, query, fresh, proven);
        tokens = decided.tokens;
        return decided.top ? decided.top : none(noFitFromRanked(), null, jev);
      } catch (err) {
        console.error("[where] Jev failed, the model picks instead:", err instanceof Error ? err.message : err);
        tokens = undefined;
      }
    }

    if (!ranked.length) return none({ reason: "no-shared-words" });
    let usage = null as LlmUsage | null;
    const raw = await complete(SYSTEM, prompt(renderMaps(maps, ranked), capture), (u) => { usage = u; });
    tokens = { in: usage?.tokensIn ?? null, out: usage?.tokensOut ?? null };
    const reply = parseReply(raw);
    if (reply === undefined) return none({ reason: "unreadable" });
    const checked = checkWhere(reply, maps);
    if (!checked.repo || !checked.files.length) return none(noFitOf(mapOf(ranked[0]!.repo), fresh), checked.modelConf);

    const map = mapOf(checked.repo);
    const best = (repo: string): RankedFile | undefined => ranked.find((r) => r.repo === repo);
    const top = best(map.repo)?.score ?? 0;
    const rel = (score: number, against: number) => (against > 0 ? score / against : 0);
    const candidates: Candidate[] = [
      ...checked.files.map((f) => ({
        repo: map.repo,
        path: f.path,
        rel: rel(ranked.find((r) => r.repo === map.repo && r.path === f.path)?.score ?? 0, top),
        whyKept: Boolean(f.why),
        fresh: fresh(map),
      })),
      // An also-fits repo is scored by its best file, against the chosen repo's best.
      ...checked.also.map((repo) => ({ repo, path: best(repo)?.path ?? "", rel: rel(best(repo)?.score ?? 0, top), whyKept: false, fresh: fresh(mapOf(repo)) })),
    ];
    const scores = await scorer.score(text, candidates);
    const pOf = (c: { repo: string; path: string }) => scores.find((s) => s.repo === c.repo && s.path === c.path)?.p ?? 0;

    const shown = checked.files.filter((f) => tierOf(pOf({ repo: map.repo, path: f.path }), scorer.cutoffs) !== "none");
    if (!shown.length) return none(noFitOf(map, fresh), checked.modelConf);
    const tier = tierOf(Math.max(...shown.map((f) => pOf({ repo: map.repo, path: f.path }))), scorer.cutoffs);
    const also = candidates
      .slice(checked.files.length)
      .map((c) => ({ repo: c.repo, tier: tierOf(pOf(c), scorer.cutoffs) }))
      .filter((a) => a.tier !== "none");

    return {
      repo: map.repo,
      tier,
      files: shown,
      also,
      map: { date: map.syncedAt.toISOString().slice(0, 10), head7: map.head7 },
      scorer: scorer.name,
      modelConf: checked.modelConf,
      tokens,
    };
  } catch (err) {
    console.error("[where] match failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

function defaultJev(): Scorer | null {
  const key = env.typesafeApiKey;
  return key ? jevScorer(key) : null;
}

const provenNote = (p: Proven) => `applied ${p.captures === 2 ? "twice" : `${p.captures} times`} before for ${p.tag}`;

/**
 * Jev rates where-rank's top files of each repo (one request per repo), plus
 * any file proven for the capture's tags that the ranker left out, with a note
 * saying so. The best file picks the repo; up to 3 of its files at Possible or
 * above are shown. Their reason is the note, or else the exported names they
 * share with the capture: facts xkg can check. `top` is null when no file
 * reaches Possible.
 */
async function decideWithJev(
  jev: Scorer,
  maps: StoredCodeMap[],
  ranked: RankedFile[],
  text: CaptureText,
  query: string,
  fresh: (m: StoredCodeMap) => boolean,
  proven: Proven[],
): Promise<{ top: WhereResult | null; tokens: NonNullable<WhereResult["tokens"]> }> {
  const pool: Candidate[] = [];
  for (const repo of new Set([...ranked.map((r) => r.repo), ...proven.map((p) => p.repo)])) {
    const map = maps.find((m) => m.repo === repo);
    if (!map) continue;
    const byPath = new Map(map.files.map((f) => [f.p, f]));
    const mine = ranked.filter((r) => r.repo === repo);
    const top = mine.slice(0, JEV_POOL);
    const notes = new Map(proven.filter((p) => p.repo === repo && byPath.has(p.path)).map((p) => [p.path, provenNote(p)]));
    // A proven file the ranker didn't score, or a repo it didn't rank at all, starts from 0
    const rel = (path: string) => (top.length ? (mine.find((r) => r.path === path)?.score ?? 0) / top[0]!.score : 0);
    const paths = [...top.map((r) => r.path), ...[...notes.keys()].filter((path) => !top.some((r) => r.path === path))];
    for (const path of paths) {
      const note = notes.get(path);
      pool.push({ repo, path, rel: rel(path), whyKept: false, fresh: fresh(map), file: byPath.get(path), ...(note ? { note } : {}) });
    }
  }

  let usage = null as LlmUsage | null;
  const scores = await jev.score(text, pool, (u) => { usage = u; });
  const tokens = { in: usage?.tokensIn ?? null, out: usage?.tokensOut ?? null };
  const tier = (p: number) => tierOf(p, jev.cutoffs);
  // A stable sort keeps the ranker's order between equal scores.
  const rated = pool
    .map((c) => ({ c, p: scores.find((s) => s.repo === c.repo && s.path === c.path)?.p ?? 0 }))
    .sort((a, b) => b.p - a.p);
  const best = rated[0];
  if (!best || tier(best.p) === "none") return { top: null, tokens };

  const map = maps.find((m) => m.repo === best.c.repo)!;
  const files = rated
    .filter((r) => r.c.repo === map.repo && tier(r.p) !== "none")
    .slice(0, MAX_FILES)
    .map(({ c }) => {
      if (c.note) return { path: c.path, why: c.note };
      const names = c.file ? sharedNames(c.file, query, map.files) : [];
      return names.length ? { path: c.path, why: `shares names with the capture: ${names.map((n) => `\`${n}\``).join(", ")}` } : { path: c.path };
    });
  const also = [...new Set(pool.map((c) => c.repo))]
    .filter((repo) => repo !== map.repo)
    .map((repo) => ({ repo, tier: tier(rated.find((r) => r.c.repo === repo)!.p) }))
    .filter((a) => a.tier !== "none");

  return {
    top: {
      repo: map.repo,
      tier: tier(best.p),
      files,
      also,
      map: { date: map.syncedAt.toISOString().slice(0, 10), head7: map.head7 },
      scorer: jev.name,
      modelConf: null,
      tokens,
    },
    tokens,
  };
}

function noFitLine(noFit: NonNullable<WhereResult["noFit"]>): string {
  const lead = "No clear fit in your repos yet:";
  switch (noFit.reason) {
    case "no-maps":
      return "No code repos synced yet.";
    case "stale":
      return `${lead} the map of ${noFit.repo} is more than ${FRESH_DAYS} days old.`;
    case "truncated":
      return `${lead} the map of ${noFit.repo} leaves out files because the repo is large.`;
    case "no-shared-words":
      return `${lead} no file or function name shares a word with this capture.`;
    case "weak":
      return `${lead} the closest files are only a weak match.`;
    case "unreadable":
      return `${lead} the match couldn't be read.`;
  }
}

/** A reply that couldn't be read is logged for its cost only: no section, card or result line. */
const unreadable = (w: WhereResult) => w.noFit?.reason === "unreadable";

function mapNote(w: WhereResult): string {
  return w.map ? `map from ${w.map.date}${w.map.head7 ? ` (${w.map.head7})` : ""}` : "";
}

/**
 * `text` as a Markdown code span with a fence longer than any run of backticks
 * in it, padded with a space when it starts or ends with a backtick or space,
 * so readCodeSpan gets back the same text.
 */
export function codeSpan(text: string): string {
  const fence = "`".repeat(Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length)) + 1);
  const pad = /^[` ]|[` ]$/.test(text) ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** The text of the code span at the start of `s` (as codeSpan writes it), or null. */
export function readCodeSpan(s: string): string | null {
  const m = /^(`+)(?!`)(.*?[^`])\1(?!`)/.exec(s);
  if (!m) return null;
  const text = m[2]!;
  return text.length > 1 && text.startsWith(" ") && text.endsWith(" ") && text.trim() ? text.slice(1, -1) : text;
}

/** The "## Where it applies" section for the capture file, or null when the user has no maps or the reply couldn't be read (the file stays as today). */
export function whereSection(w: WhereResult): string | null {
  if (w.noFit?.reason === "no-maps" || unreadable(w)) return null;
  if (w.noFit || !w.repo) return `## Where it applies\n${noFitLine(w.noFit ?? { reason: "weak" })}\n`;
  const head = [`**${FIT_LABEL[w.tier]}**`, w.repo, PROVENANCE, mapNote(w)].filter(Boolean).join(" · ");
  const files = w.files.map((f) => `- ${codeSpan(f.path)}${f.why ? `: ${f.why}` : ""}\n`).join("");
  const also = w.also.length ? `Also fits: ${w.also.map((a) => `${a.repo} (${FIT_LABEL[a.tier]})`).join(", ")}\n` : "";
  return `## Where it applies\n${head}\n${files}${also}`;
}

export function whereCard(w: WhereResult): WhereCard | null {
  if (unreadable(w)) return null;
  const label = PROVENANCE.charAt(0).toUpperCase() + PROVENANCE.slice(1);
  return {
    fit: FIT_LABEL[w.tier],
    repo: w.repo,
    files: w.files,
    also: w.also.map((a) => ({ repo: a.repo, fit: FIT_LABEL[a.tier] })),
    note: w.noFit || !w.repo ? noFitLine(w.noFit ?? { reason: "weak" }) : [label, mapNote(w)].filter(Boolean).join(" · "),
  };
}

/** The capture file with the section right after "## Core idea"; unchanged if it has no Core idea or already has the section. */
export function insertWhereSection(markdown: string, section: string): string {
  const core = /^## Core idea\n/m.exec(markdown);
  if (!core) return markdown;
  const next = markdown.indexOf("\n## ", core.index + core[0].length);
  if (next < 0) return markdown;
  // Only a section in this spot counts: the captured source may have the same heading.
  if (markdown.startsWith("## Where it applies\n", next + 1)) return markdown;
  return `${markdown.slice(0, next + 1)}${section}\n${markdown.slice(next + 1)}`;
}

const TIER_OF_LABEL = new Map(Object.entries(FIT_LABEL).map(([tier, label]) => [label, tier as Tier]));

/**
 * The fit a saved capture's "Where it applies" section shows: repo, tier, file
 * paths and also-fits repos. Null when it has no section with a fit. Only the
 * section right after "## Core idea" counts, never one in the captured source.
 */
export function readWhereSection(markdown: string): { repo: string; tier: Tier; files: string[]; also: { repo: string; tier: Tier }[] } | null {
  const core = /^## Core idea\n/m.exec(markdown);
  if (!core) return null;
  const start = markdown.indexOf("\n## ", core.index + core[0].length) + 1;
  if (start === 0 || !markdown.startsWith("## Where it applies\n", start)) return null;
  const end = markdown.indexOf("\n## ", start);
  const lines = markdown.slice(start, end < 0 ? undefined : end).split("\n").slice(1);
  const head = /^\*\*(.+?)\*\* · ([^ ]+)/.exec(lines[0] ?? "");
  const tier = head && TIER_OF_LABEL.get(head[1]!);
  if (!head || !tier || tier === "none") return null;
  const files = lines.flatMap((l) => (l.startsWith("- `") ? readCodeSpan(l.slice(2)) ?? [] : []));
  const alsoLine = lines.find((l) => l.startsWith("Also fits: "))?.slice("Also fits: ".length) ?? "";
  const also = alsoLine
    .split(", ")
    .flatMap((part) => {
      const m = /^(\S+) \((.+)\)$/.exec(part);
      const t = m && TIER_OF_LABEL.get(m[2]!);
      return m && t ? [{ repo: m[1]!, tier: t }] : [];
    });
  return { repo: head[2]!, tier, files, also };
}

/** Adds the section to the saved capture file (best-effort). True when the file was updated. */
export async function writeWhereSection(githubToken: string, repo: string, path: string, where: WhereResult): Promise<boolean> {
  const section = whereSection(where);
  if (!section) return false;
  try {
    const file = await readFile(githubToken, repo, path);
    if (!file) return false;
    const updated = insertWhereSection(file.content, section);
    if (updated === file.content) return false;
    await githubPut(githubToken, repo, path, updated, `where: note where ${path.replace(/^.*\//, "")} applies`, file.sha);
    return true;
  } catch {
    return false;
  }
}

/** One line for the MCP tool result, or null when nothing was written. */
export function whereLine(where: WhereResult): string | null {
  if (where.noFit?.reason === "no-maps" || unreadable(where)) return null;
  if (where.noFit || !where.repo) return `Where it applies: ${noFitLine(where.noFit ?? { reason: "weak" })}`;
  return `Where it applies: ${FIT_LABEL[where.tier]} in ${where.repo}: ${where.files.map((f) => f.path).join(", ")} (${PROVENANCE}).`;
}
