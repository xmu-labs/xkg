/**
 * Pre-ranker for "Where it applies": scores the files of the user's code maps
 * against a capture with no LLM and no embeddings, then fits the maps into the
 * matching prompt's budget. BM25 over names (exported names, file name,
 * folders), then one step along import links from the best files.
 */

import type { MapFile } from "./code-map";

export interface RepoMap {
  repo: string;
  files: MapFile[];
}

export interface RankedFile {
  repo: string;
  path: string;
  score: number;
}

/** The maps take at most this much of the matching prompt (~12K tokens). */
export const MAP_BUDGET_BYTES = 48 * 1024;

const CAMEL = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;

/** Lowercase words of a text, with camelCase and snake_case identifiers split (the whole identifier is kept too). */
function words(text: string): string[] {
  const out: string[] = [];
  for (const run of text.match(/[A-Za-z0-9]+/g) ?? []) {
    const parts = run.split(CAMEL).filter(Boolean);
    for (const p of parts) out.push(p.toLowerCase());
    if (parts.length > 1) out.push(run.toLowerCase());
  }
  return out;
}

const SUFFIXES = ["ations", "ation", "ances", "ance", "ences", "ence", "ants", "ant", "ents", "ent", "ings", "ing", "ed", "es", "s"];

/** A small suffix stripper: enough for capture/captures, relevance/relevant, memory/memories. */
function stem(w: string): string {
  if (w.length > 6 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  for (const s of SUFFIXES) {
    if (w.length > s.length + 3 && w.endsWith(s)) {
      w = w.slice(0, -s.length);
      break;
    }
  }
  return w.length > 4 && w.endsWith("e") ? w.slice(0, -1) : w;
}

// Extraction writes "The source recommends …", so those words describe the
// article, not the code.
const STOP = new Set(
  ("the a an and or but not for from with into onto of to in on at by as is are was were be been being can could " +
    "should would will may might must has have had this that these those there here its their them they about any all " +
    "some how what why when where which who does did do it source recommends").split(" "),
);

/** The words of a capture that can match a file: no filler, nothing under 3 letters, stemmed. */
export function terms(text: string): string[] {
  return words(text).filter((w) => !STOP.has(w) && w.length > 2).map(stem);
}

/**
 * Up to `max` names the file exports that share a word with the capture. Names
 * sharing a word that few files in `repo` export come first (in an LLM app,
 * "llm" is everywhere and says nothing); export order breaks ties.
 */
export function sharedNames(file: MapFile, capture: string, repo: MapFile[] = [file], max = 3): string[] {
  const wanted = new Set(terms(capture));
  const df = new Map<string, number>();
  for (const f of repo) for (const t of new Set(terms((f.e ?? []).join(" ")))) if (wanted.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
  const rarest = (name: string) => Math.min(...terms(name).filter((t) => wanted.has(t)).map((t) => df.get(t) ?? 1));
  return (file.e ?? [])
    .filter((name) => terms(name).some((t) => wanted.has(t)))
    .map((name) => ({ name, df: rarest(name) }))
    .sort((a, b) => a.df - b.df)
    .slice(0, max)
    .map((n) => n.name);
}

const WEIGHTS = { e: 3, n: 2, d: 1 } as const;
const IGNORED_DIRS = new Set(["src", "lib", "app"]);

function fields(f: MapFile): Record<keyof typeof WEIGHTS, string[]> {
  const slash = f.p.lastIndexOf("/");
  const base = f.p.slice(slash + 1).replace(/\.[^.]*$/, "");
  const dirs = slash > 0 ? f.p.slice(0, slash) : "";
  return {
    e: words((f.e ?? []).join(" ")).map(stem),
    n: words(base).map(stem),
    d: words(dirs).filter((w) => !IGNORED_DIRS.has(w)).map(stem),
  };
}

/** BM25 over one repo's files (each repo is its own corpus). */
function bm25(files: MapFile[], query: string[], k1 = 1.2, b = 0.75): number[] {
  const qtf = new Map<string, number>();
  for (const t of query) qtf.set(t, (qtf.get(t) ?? 0) + 1);
  const docs = files.map(fields);
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set([...d.e, ...d.n, ...d.d])) df.set(t, (df.get(t) ?? 0) + 1);
  const lens = docs.map((d) => d.e.length + d.n.length + d.d.length);
  const avg = lens.reduce((a, l) => a + l, 0) / Math.max(docs.length, 1) || 1;
  const n = docs.length;

  return docs.map((d, i) => {
    let s = 0;
    for (const [t, qn] of qtf) {
      let tf = 0;
      for (const k of ["e", "n", "d"] as const) tf += WEIGHTS[k] * d[k].filter((w) => w === t).length;
      if (!tf) continue;
      const dft = df.get(t) ?? 0;
      const idf = Math.log(1 + (n - dft + 0.5) / (dft + 0.5));
      s += ((idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * lens[i]!) / avg))) * (1 + Math.log(qn));
    }
    return s;
  });
}

const SEEDS = 5;
const LINK_DECAY = 0.5;
// Files most others import (types, db, env) say nothing about a capture, so
// links never promote them. In a small repo the 90th percentile can be 1, so a
// hub also needs at least this many importers.
const MIN_HUB_DEGREE = 3;

/** One step along import links from the top files, both directions, at half their score; hubs are skipped. */
function expand(files: MapFile[], scores: number[]): number[] {
  const index = new Map(files.map((f, i) => [f.p, i]));
  const neighbors = files.map(() => new Set<number>());
  const indegree = files.map(() => 0);
  files.forEach((f, i) => {
    for (const p of f.i ?? []) {
      const j = index.get(p);
      if (j === undefined || j === i) continue;
      neighbors[i]!.add(j);
      neighbors[j]!.add(i);
      indegree[j]!++;
    }
  });
  const degrees = indegree.filter((d) => d > 0).sort((a, b) => a - b);
  if (!degrees.length) return scores;
  const hub = Math.max(degrees[Math.floor(degrees.length * 0.9)]!, MIN_HUB_DEGREE);

  const out = [...scores];
  const seeds = scores
    .map((s, i) => [s, i] as const)
    .filter(([s]) => s > 0)
    .sort((a, b) => b[0] - a[0])
    .slice(0, SEEDS);
  for (const [s, i] of seeds) {
    for (const j of neighbors[i]!) {
      if (indegree[j]! >= hub) continue;
      out[j] = Math.max(out[j]!, s * LINK_DECAY);
    }
  }
  return out;
}

/** Every file with a score above zero, best first, across all repos. */
export function rankFiles(maps: RepoMap[], capture: string, opts: { links?: boolean } = {}): RankedFile[] {
  const query = terms(capture);
  if (!query.length) return [];
  const ranked: RankedFile[] = [];
  for (const map of maps) {
    let scores = bm25(map.files, query);
    if (opts.links !== false) scores = expand(map.files, scores);
    map.files.forEach((f, i) => {
      if (scores[i]! > 0) ranked.push({ repo: map.repo, path: f.p, score: scores[i]! });
    });
  }
  return ranked.sort((a, b) => b.score - a.score);
}

function fullLine(f: MapFile): string {
  let line = f.p;
  if (f.e?.length) line += ` | exports: ${f.e.join(", ")}`;
  if (f.i?.length) line += ` | imports: ${f.i.join(", ")}`;
  return `${line}\n`;
}

const header = (repo: string) => `### ${repo}\n`;
const size = (s: string) => Buffer.byteLength(s, "utf8");

/**
 * The maps as prompt text. Maps that fit the budget go in whole, in stored
 * order. Over budget: the best files keep their exports (up to a quarter of the
 * budget), then every other file goes in as a path, best first, until the
 * budget is spent; what's left upgrades more of the best files.
 */
export function renderMaps(maps: RepoMap[], ranked: RankedFile[], budget = MAP_BUDGET_BYTES): string {
  const whole = maps.map((m) => header(m.repo) + m.files.map(fullLine).join("")).join("");
  if (size(whole) <= budget) return whole;

  const scoreOf = new Map(ranked.map((r) => [`${r.repo}\0${r.path}`, r.score]));
  type Entry = { ri: number; idx: number; file: MapFile; score: number; depth: number; full?: boolean };
  const entries: Entry[] = maps.flatMap((m, ri) =>
    m.files.map((file, idx) => ({ ri, idx, file, score: scoreOf.get(`${m.repo}\0${file.p}`) ?? 0, depth: file.p.split("/").length })),
  );
  const byScore = (a: Entry, b: Entry) => b.score - a.score || a.ri - b.ri || a.depth - b.depth || a.idx - b.idx;
  const scored = entries.filter((e) => e.score > 0).sort(byScore);

  const chosen = new Set<Entry>();
  const reposUsed = new Set<number>();
  let used = 0;
  const costOf = (e: Entry, line: string) => size(line) + (reposUsed.has(e.ri) ? 0 : size(header(maps[e.ri]!.repo)));
  const take = (e: Entry, full: boolean) => {
    used += costOf(e, full ? fullLine(e.file) : `${e.file.p}\n`);
    reposUsed.add(e.ri);
    chosen.add(e);
    e.full = full;
  };

  let detail = 0;
  for (const e of scored) {
    const cost = costOf(e, fullLine(e.file));
    if (detail + cost > budget / 4) continue;
    detail += cost;
    take(e, true);
  }
  for (const e of [...entries].sort(byScore)) {
    if (chosen.has(e)) continue;
    if (used + costOf(e, `${e.file.p}\n`) > budget) break;
    take(e, false);
  }
  for (const e of scored) {
    if (!chosen.has(e) || e.full) continue;
    const extra = size(fullLine(e.file)) - size(`${e.file.p}\n`);
    if (used + extra > budget) continue;
    used += extra;
    e.full = true;
  }

  const best = (ri: number) => Math.max(0, ...[...chosen].filter((e) => e.ri === ri).map((e) => e.score));
  const repoOrder = [...reposUsed].sort((a, b) => best(b) - best(a) || a - b);
  return repoOrder
    .map((ri) => {
      const lines = [...chosen]
        .filter((e) => e.ri === ri)
        .sort((a, b) => b.score - a.score || a.idx - b.idx)
        .map((e) => (e.full ? fullLine(e.file) : `${e.file.p}\n`));
      return header(maps[ri]!.repo) + lines.join("");
    })
    .join("");
}
