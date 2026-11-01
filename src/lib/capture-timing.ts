/**
 * One timing log line per capture, shared by the web route and the MCP tool,
 * so slow steps show up in the logs. The line never holds the capture's name,
 * content or URL, or the provider's error text.
 */

import { effortApplied, resolveLlm, type LlmConfig, type LlmUsage } from "./llm";
import type { CaptureStats } from "./types";

/** Milliseconds per step since the previous mark, plus when the answer left. */
export function stepTimer() {
  const start = Date.now();
  let last = start;
  const ms: Record<string, number> = {};
  return {
    ms,
    mark(step: string) {
      const now = Date.now();
      ms[step] = now - last;
      last = now;
    },
    /** What the user (or agent) waited for: start to the answer. */
    answered() {
      ms.total = Date.now() - start;
    },
  };
}

export type StepTimer = ReturnType<typeof stepTimer>;

type Via = "web" | "mcp";

function base(via: Via, llm: LlmConfig, usage: LlmUsage | null, fetched: boolean) {
  const { provider, model, effort } = resolveLlm(llm);
  return {
    event: "capture.timing" as const, via, provider, model, effort, effortApplied: effortApplied(llm), fetched,
    tokensIn: usage?.tokensIn ?? null, tokensOut: usage?.tokensOut ?? null,
  };
}

/** `total` is the wait; `background` is the linking and section work after the answer. */
export function timingLine(
  via: Via, timer: StepTimer, llm: LlmConfig, usage: LlmUsage | null, fetched: boolean,
  capture: { stats?: CaptureStats },
) {
  const ms: Record<string, number> = { ...timer.ms, background: (timer.ms.link ?? 0) + (timer.ms.where ?? 0) };
  const s = capture.stats;
  return {
    ...base(via, llm, usage, fetched), ok: true as const,
    claimsProposed: s?.claimsProposed ?? null, claimsKept: s?.claimsKept ?? null, fieldsTotal: s?.fieldsTotal ?? null,
    ms,
  };
}

/** The line for an extraction that failed: how long it ran and what kind of failure, never the message. */
export function failureLine(via: Via, timer: StepTimer, llm: LlmConfig, usage: LlmUsage | null, fetched: boolean, err: unknown) {
  return { ...base(via, llm, usage, fetched), ok: false as const, error: errorClass(err), ms: { ...timer.ms } };
}

/** A failure's kind, from its message: timeout, http_<status>, invalid_json or other. */
export function errorClass(err: unknown): string {
  const message = err instanceof Error ? err.message : "";
  if (/No answer from the provider|timed out/i.test(message)) return "timeout";
  const status = /HTTP (\d{3})\b/.exec(message) ?? /^(\d{3})\b/.exec(message);
  if (status) return `http_${status[1]}`;
  if (/invalid JSON/i.test(message)) return "invalid_json";
  return "other";
}
