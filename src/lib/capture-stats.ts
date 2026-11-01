/** What the capture route returns about the model call (see ModelHint). */
export interface CaptureUsage {
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
  /** The server's extraction time, without fetching or saving. */
  extractMs?: number | null;
  /** Whether the effort setting was sent to the provider. */
  effortApplied?: boolean;
}
