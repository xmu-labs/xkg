/** Status of a capture in the knowledge repo. */
export type CaptureStatus = "inbox" | "applied" | "archived";

/** LLM provider the user has configured (BYOK — bring your own key). See lib/providers. */
export type { LlmProvider } from "./providers";
import type { LlmProvider } from "./providers";

/** How hard the model reasons before answering. Absent = the model's own default. */
export type LlmEffort = "low" | "medium" | "high";

/** A user's LLM choice: provider (from their key), plus optional model and effort. */
export interface LlmSettings {
  provider: LlmProvider;
  /** Any model the provider serves; null/blank = xkg's default for the provider. */
  model?: string | null;
  effort?: LlmEffort | null;
}

/** How the capture was originally submitted. */
export type SourceType = "url" | "note" | "paste";

/** Content types supported by the knowledge extraction engine. */
export type ContentType =
  | "article"
  | "blog"
  | "research"
  | "transcript"
  | "notes"
  | "post"
  | "book"
  | "thread"
  | "video";

/** Structured output from the LLM extraction. */
export interface ExtractedCapture {
  slug: string;
  inferredTitle: string;
  inferredAuthor: string | null;
  inferredUrl: string | null;
  inferredType: ContentType;
  coreIdea: string;
  takeaways: string[];
  quotes: string[];
  tags: string[];
  appliedTo: string | null;
  lowConfidence: boolean;
  source_type?: SourceType;
  /** Claims whose evidence the app checked against `source` (see lib/evidence). */
  claims?: Claim[];
  /** The exact text the extraction ran on and the claims were checked against. */
  source?: SourceSnapshot;
}

/** One numbered piece of source text the model can cite. */
export interface SourceSegment {
  segmentId: string;
  text: string;
}

/** A source as sent to extraction: app-generated ids, metadata and segments. */
export interface SourceSnapshot {
  /** Stable per source: from the URL when there is one, else from the text. */
  sourceId: string;
  /** Changes whenever the text changes: derived from `sha256`. */
  sourceVersionId: string;
  /** sha256 (hex) of the segment texts joined by a blank line. */
  sha256: string;
  title?: string;
  url?: string;
  truncated: boolean;
  segments: SourceSegment[];
}

/** An exact excerpt from a segment that supports a claim. */
export interface ClaimEvidence {
  sourceId: string;
  sourceVersionId: string;
  segmentId: string;
  exactQuote: string;
}

/** A coreIdea or takeaway with evidence the app verified in the source. */
export interface Claim {
  /** Stable: derived from the source version and the claim text. */
  id: string;
  /** "/coreIdea" or "/takeaways/<n>". */
  outputPath: string;
  text: string;
  kind: "source_assertion";
  evidence: ClaimEvidence[];
}

/** A related capture identified by the auto-linking system. */
export interface RelatedCapture {
  filename: string;
  reason: string;
}

/** A capture ranked by semantic relevance to a task context. */
export interface RelevanceResult {
  filename: string;
  score: number;
  reason: string;
}

/** Output from the knowledge synthesis LLM call. */
export interface SynthesisResult {
  topic: string;
  rules: string[];
}

/** A concrete suggestion for applying knowledge to the agent's current context. */
export interface ApplicationSuggestion {
  filename: string;
  insight: string;
  suggestion: string;
}

/** Result of curating a single capture (URL check + confidence check). */
export interface CurationResult {
  filename: string;
  status: "ok" | "stale" | "low_confidence" | "stale_and_low_confidence";
  url: string | null;
  httpStatus: number | null;
  reason: string;
  archived?: boolean;
}
