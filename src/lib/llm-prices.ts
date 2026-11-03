/**
 * List prices per million tokens (USD), for an estimate of what a call cost
 * with the user's own key. Checked 2026-11; providers change prices, and
 * cached input is priced as full input, so the figure is "about", never a
 * bill. A model not listed gives no estimate rather than a guess.
 */

import type { LlmProvider } from "./providers";

type Price = { in: number; out: number };

const PRICES: Record<LlmProvider, Record<string, Price>> = {
  anthropic: {
    "claude-haiku-4-5": { in: 1, out: 5 },
    "claude-haiku-5-5": { in: 0.1, out: 0.5 },
    "claude-sonnet-4-5": { in: 3, out: 15 },
    "claude-sonnet-4-6": { in: 3, out: 15 },
    "claude-sonnet-5": { in: 2, out: 10 },
    "claude-sonnet-5-5": { in: 2, out: 10 },
    "claude-opus-5": { in: 5, out: 25 },
    "claude-opus-5-5": { in: 4, out: 20 },
  },
  openai: {
    "gpt-4o-mini": { in: 0.15, out: 0.6 },
    "gpt-4o": { in: 2.5, out: 10 },
    "gpt-4.1": { in: 2, out: 8 },
    "gpt-4.1-mini": { in: 0.4, out: 1.6 },
    "gpt-5-mini": { in: 0.25, out: 2 },
    "gpt-5": { in: 1.25, out: 10 },
    "o4-mini": { in: 1.1, out: 4.4 },
  },
  google: {
    "gemini-2.0-flash": { in: 0.1, out: 0.4 },
    "gemini-2.5-flash": { in: 0.3, out: 2.5 },
    "gemini-2.5-pro": { in: 1.25, out: 10 },
  },
  openrouter: {
    "openai/gpt-4o-mini": { in: 0.15, out: 0.6 },
    "anthropic/claude-sonnet-4.5": { in: 3, out: 15 },
    "google/gemini-2.5-flash": { in: 0.3, out: 2.5 },
    "meta-llama/llama-3.3-70b-instruct": { in: 0.13, out: 0.4 },
    "qwen/qwen3-235b-a22b": { in: 0.2, out: 0.6 },
    "deepseek/deepseek-chat": { in: 0.28, out: 0.42 },
  },
  xai: {
    "grok-3-mini": { in: 0.3, out: 0.5 },
    "grok-4": { in: 3, out: 15 },
  },
  deepseek: {
    "deepseek-chat": { in: 0.28, out: 0.42 },
    "deepseek-reasoner": { in: 0.28, out: 0.42 },
  },
  mistral: {
    "mistral-small-latest": { in: 0.1, out: 0.3 },
    "mistral-medium-latest": { in: 0.4, out: 2 },
    "mistral-large-latest": { in: 0.5, out: 1.5 },
  },
  groq: {
    "llama-3.3-70b-versatile": { in: 0.59, out: 0.79 },
    "openai/gpt-oss-120b": { in: 0.15, out: 0.75 },
    "qwen/qwen3-32b": { in: 0.29, out: 0.59 },
  },
};

/** What a call likely cost in USD, or null when the model has no price on file. */
export function estimateCostUsd(provider: LlmProvider, model: string, tokensIn: number, tokensOut: number): number | null {
  const price = PRICES[provider]?.[model];
  if (!price) return null;
  return (tokensIn * price.in + tokensOut * price.out) / 1_000_000;
}
