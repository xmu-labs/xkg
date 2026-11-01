/**
 * Each provider's fastest listed model that still keeps the checked quotes,
 * measured by scripts/measure-model-speed.ts on a fixed set of sources against
 * one reasoning model, and stored in model-speed.json. The faster-model hint
 * and the Settings hint quote it.
 * Safe to import in the browser: no keys, no network.
 */

import { PROVIDERS } from "./providers";
import type { LlmProvider } from "./types";
import measured from "./model-speed.json";

export interface ModelSpeedRow {
  provider: LlmProvider;
  /** The fastest listed model whose checked quotes stay close to the reasoning model's. */
  fastModel: string;
  /** Its mean extraction time, in milliseconds. */
  fastMeanMs: number;
  /** Share of fields with a checked quote: kept claims / fields. */
  coverageFast: number;
  /** The reasoning model it was compared against, on the same sources. */
  slowModel: string;
  slowMeanMs: number;
  coverageSlow: number;
  /** How many sources were measured. */
  sources: number;
  /** YYYY-MM-DD. */
  measuredOn: string;
}

export const MODEL_SPEED = measured as ModelSpeedRow[];

/** A row older than this is never quoted. */
export const STALE_AFTER_DAYS = 90;

/** The provider's row, if its fast model is still listed and the row is recent. */
export function speedRow(provider: LlmProvider, now: Date = new Date(), table: ModelSpeedRow[] = MODEL_SPEED): ModelSpeedRow | null {
  const row = table.find((r) => r.provider === provider);
  if (!row || !PROVIDERS[provider]?.models.includes(row.fastModel)) return null;
  const ageDays = (now.getTime() - new Date(`${row.measuredOn}T00:00:00Z`).getTime()) / 86_400_000;
  return ageDays <= STALE_AFTER_DAYS ? row : null;
}
