/**
 * One timing log line per capture, shared by the web route and the MCP tool,
 * so slow steps show up in the logs. The line never holds the capture's name,
 * content or URL.
 */

import { resolveLlm, type LlmConfig, type LlmUsage } from "./llm";

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

/** `total` is the wait; `background` is the linking and section work after the answer. */
export function timingLine(via: "web" | "mcp", timer: StepTimer, llm: LlmConfig, usage: LlmUsage | null, fetched: boolean) {
  const { provider, model, effort } = resolveLlm(llm);
  const ms = { ...timer.ms, background: (timer.ms.link ?? 0) + (timer.ms.where ?? 0) };
  return { event: "capture.timing", via, provider, model, effort, fetched, tokensIn: usage?.tokensIn ?? null, tokensOut: usage?.tokensOut ?? null, ms };
}
