/**
 * Whether a capture's result card offers the provider's measured fast model.
 * Pure, so the page decides it from the result and the user's settings.
 */

import type { ModelSpeedRow } from "./model-speed";
import type { LlmEffort, LlmProvider } from "./types";

/** A capture whose model took at least this long is slow. */
export const SLOW_MS = 20_000;

/** The value "Keep mine" stores: the hint stays quiet for this model and effort. */
export function nudgeKey(model: string, effort: LlmEffort | null): string {
  return `${model}/${effort ?? "auto"}`;
}

export interface NudgeInput {
  provider: LlmProvider;
  /** The model that ran the capture. */
  model: string;
  effort: LlmEffort | null;
  /** The server's extraction time; null from older servers. */
  extractMs: number | null | undefined;
  dismissedFor: string | null | undefined;
  /** The provider's fresh measured row (speedRow), or null. */
  row: ModelSpeedRow | null;
}

/** How much lower the fast model's quote coverage may be than the reasoning model's. */
export const COVERAGE_SLACK = 0.1;

export interface Nudge {
  model: string;
  tookSeconds: number;
  usualSeconds: number;
}

export function recommendFaster({ provider, model, effort, extractMs, dismissedFor, row }: NudgeInput): Nudge | null {
  if (typeof extractMs !== "number" || extractMs < SLOW_MS) return null;
  if (!row || row.provider !== provider || model === row.fastModel) return null;
  if (dismissedFor === nudgeKey(model, effort)) return null;
  // Only a model clearly faster than this capture, that keeps the checked quotes.
  if (extractMs < 2 * row.fastMeanMs) return null;
  if (row.coverageFast < row.coverageSlow - COVERAGE_SLACK) return null;
  return {
    model: row.fastModel,
    tookSeconds: Math.round(extractMs / 1000),
    usualSeconds: Math.max(1, Math.round(row.fastMeanMs / 1000)),
  };
}
