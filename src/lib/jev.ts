/**
 * Jev, TypeSafe's decision model, decides where a capture applies. One request
 * per repo asks, for each candidate file from the name ranker, whether applying
 * the capture would change that file, and whether anything in the repo fits at
 * all. Only names leave xkg: the repo name, file paths, exported names, mapped
 * import paths and the capture's extracted text. Never code.
 *
 * The questions and cutoffs live here so they can be read and tuned together.
 * A failed call is an error, never a "no": the caller falls back to the model.
 */

import type { MapFile } from "./code-map";
import type { LlmUsage } from "./llm";
import type { CaptureText, Cutoffs, Scorer } from "./where-score";

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
/** Pinned: the cutoffs below were set against this version's answers. */
export const JEV_MODEL = "jev-1.14.0";
export const JEV_TIMEOUT_MS = 5000;
/**
 * Set from 30 captures with known targets over two repos (12 with a code fit,
 * 18 without): no card on any of the 18, at the cost of one fit missed. A
 * shift of 0.05 moves one or two captures, so re-measure before changing.
 */
export const JEV_CUTOFFS: Cutoffs = { strong: 0.5, possible: 0.4 };

const MAX_EXPORTS = 50;
const MAX_IMPORTS = 20;

type FileState = { exports: string[]; imports: string[] };

export function jevPayload(repo: string, capture: CaptureText, files: MapFile[]) {
  const listed = files.map((f) => ({ path: f.p, exports: (f.e ?? []).slice(0, MAX_EXPORTS), imports: (f.i ?? []).slice(0, MAX_IMPORTS) }));
  const questions: Record<string, { type: "noul"; instructions: unknown; criteria: { true: string; false: string } }> = {};
  listed.forEach((file, i) => {
    questions[`fit_${i}`] = {
      type: "noul",
      instructions: { question: `Would a developer applying a takeaway from \`capture\` to ${repo} change this file?`, file },
      criteria: {
        true: "The file holds the code that one of the takeaways is about, so applying it means editing this file.",
        false: "The file does a different job; it only shares general words (such as model, cache, or routing) with the capture.",
      },
    };
  });
  questions.anything_fits = {
    type: "noul",
    instructions: `Does any takeaway in \`capture\` call for a concrete code change in ${repo}?`,
    criteria: {
      true: `A developer could name a change in ${repo} code that applies a takeaway.`,
      false: `The capture is about a different domain or is general advice with no code change in ${repo}.`,
    },
  };
  return {
    model: JEV_MODEL,
    state: {
      repo: { name: repo, candidate_files: Object.fromEntries(listed.map(({ path, ...rest }) => [path, rest])) as Record<string, FileState> },
      capture: { title: capture.title, core_idea: capture.coreIdea, takeaways: capture.takeaways },
    },
    questions,
  };
}

export interface JevAnswer {
  /** Yes-score per file, in the order sent. */
  fits: number[];
  anythingFits: number;
  tokensIn: number | null;
  tokensOut: number | null;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

function yes(answers: Record<string, unknown>, name: string): number {
  const a = answers[name] as { type?: unknown; noul?: unknown } | undefined;
  if (a?.type !== "noul" || typeof a.noul !== "number" || !(a.noul >= 0 && a.noul <= 1)) {
    throw new Error(`jev: no yes/no answer for ${name}`);
  }
  return a.noul;
}

/** One request for one repo's candidate files. Throws on any failure. */
export async function askJev(apiKey: string, repo: string, capture: CaptureText, files: MapFile[], fetchImpl: Fetch = fetch): Promise<JevAnswer> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), JEV_TIMEOUT_MS);
  let body: unknown;
  try {
    const res = await fetchImpl(JEV_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(jevPayload(repo, capture, files)),
      signal: abort.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } catch (err) {
    throw new Error(`jev: ${abort.signal.aborted ? `no answer in ${JEV_TIMEOUT_MS / 1000} s` : err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  const { answers, usage } = (body ?? {}) as { answers?: Record<string, unknown>; usage?: { input_tokens?: unknown; output_tokens?: unknown } };
  if (!answers || typeof answers !== "object") throw new Error("jev: reply has no answers");
  const count = (n: unknown) => (typeof n === "number" ? n : null);
  return {
    fits: files.map((_, i) => yes(answers, `fit_${i}`)),
    anythingFits: yes(answers, "anything_fits"),
    tokensIn: count(usage?.input_tokens),
    tokensOut: count(usage?.output_tokens),
  };
}

/**
 * Jev as a scorer: one request per repo, in parallel. A file can't fit better
 * than "anything in this repo fits", so its p is the product of the two: it
 * stays under that gate and keeps Jev's order between files (taking the lower
 * of the two flattens most files to the gate, and the ranker's order decides).
 */
export function jevScorer(apiKey: string, fetchImpl: Fetch = fetch): Scorer {
  return {
    name: "jev",
    cutoffs: JEV_CUTOFFS,
    async score(capture, candidates, onUsage?: (usage: LlmUsage) => void) {
      const byRepo = new Map<string, MapFile[]>();
      for (const c of candidates) {
        if (!c.file) throw new Error(`jev: no map entry for ${c.path}`);
        byRepo.set(c.repo, [...(byRepo.get(c.repo) ?? []), c.file]);
      }
      const repos = [...byRepo.keys()];
      const answers = await Promise.all(repos.map((repo) => askJev(apiKey, repo, capture, byRepo.get(repo)!, fetchImpl)));

      const p = new Map<string, number>();
      repos.forEach((repo, r) => {
        const a = answers[r]!;
        byRepo.get(repo)!.forEach((f, i) => p.set(`${repo}\n${f.p}`, a.fits[i]! * a.anythingFits));
      });
      // Like the model path, usage is reported only when every count is known:
      // a missing count is unknown, not zero.
      if (answers.every((a) => a.tokensIn !== null && a.tokensOut !== null)) {
        const sum = (k: "tokensIn" | "tokensOut") => answers.reduce((n, a) => n + a[k]!, 0);
        onUsage?.({ tokensIn: sum("tokensIn"), tokensOut: sum("tokensOut") });
      }
      return candidates.map((c) => ({ repo: c.repo, path: c.path, p: p.get(`${c.repo}\n${c.path}`)! }));
    },
  };
}
