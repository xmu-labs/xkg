/** What a capture cost, as the result card shows it. */
export interface CaptureUsage {
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
}

function count(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

/** "23s · 3.2k tokens · model", or null when the server sent no usage. */
export function captureStats(elapsedMs: number, usage: CaptureUsage | undefined): string | null {
  if (!usage) return null;
  const seconds = Math.round(elapsedMs / 1000);
  const parts = [seconds < 1 ? "under 1s" : `${seconds}s`];
  if (typeof usage.tokensIn === "number" && typeof usage.tokensOut === "number") {
    parts.push(`${count(usage.tokensIn + usage.tokensOut)} tokens`);
  }
  parts.push(usage.model);
  return parts.join(" · ");
}
