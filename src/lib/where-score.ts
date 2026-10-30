/**
 * How sure xkg is that a suggested file fits a capture. The tier on the card
 * comes from a scorer, never from the model's own confidence: a model rates
 * its picks 0.9+ whether they are right or not. Scorers plug in here: Jev
 * (jev.ts) when xkg's TypeSafe key is set, else this evidence scorer, which
 * uses only what xkg can check, with no LLM and no key.
 */

import type { MapFile } from "./code-map";
import type { LlmUsage } from "./llm";

export type Tier = "strong" | "possible" | "none";

export interface CaptureText {
  title: string;
  coreIdea: string;
  takeaways: string[];
}

/** A file the model picked and the check kept. */
export interface Candidate {
  repo: string;
  path: string;
  /** The file's name-ranking score relative to the best file in the maps (0–1). */
  rel: number;
  /** Its reason passed the name check. */
  whyKept: boolean;
  /** Its repo's map was synced in the last 14 days. */
  fresh: boolean;
  /** The file's map entry (paths and names only), for scorers that read it. */
  file?: MapFile;
  /** What earlier applies taught about the file, e.g. "applied twice before for llm", for scorers that read it. */
  note?: string;
}

/** p at or above `strong` is a Strong fit, at or above `possible` a Possible fit. */
export interface Cutoffs {
  strong: number;
  possible: number;
}

export interface Scorer {
  name: string;
  cutoffs: Cutoffs;
  score(capture: CaptureText, candidates: Candidate[], onUsage?: (usage: LlmUsage) => void): Promise<{ repo: string; path: string; p: number }[]>;
}

export const STRONG_FIT = 0.7;
export const POSSIBLE_FIT = 0.4;
const EVIDENCE_CUTOFFS: Cutoffs = { strong: STRONG_FIT, possible: POSSIBLE_FIT };

export function tierOf(p: number, cutoffs: Cutoffs = EVIDENCE_CUTOFFS): Tier {
  if (p >= cutoffs.strong) return "strong";
  if (p >= cutoffs.possible) return "possible";
  return "none";
}

// Fixed weights, tuned on the capture with known targets: a checked pick
// starts at 0.25, and name ranking counts most.
const PICKED = 0.25;
const RANK = 0.45;
const REASON = 0.15;
const FRESH = 0.15;

const clamp = (n: number) => Math.min(1, Math.max(0, n));

export const evidenceScorer: Scorer = {
  name: "evidence",
  cutoffs: EVIDENCE_CUTOFFS,
  async score(_capture, candidates) {
    return candidates.map((c) => ({
      repo: c.repo,
      path: c.path,
      p: clamp(PICKED + RANK * clamp(c.rel) + (c.whyKept ? REASON : 0) + (c.fresh ? FRESH : 0)),
    }));
  },
};
