/** Status of a capture in the knowledge repo. */
export type CaptureStatus = "inbox" | "applied" | "archived";

/** LLM provider the user has configured (BYOK — bring your own key). */
export type LlmProvider = "anthropic" | "openai" | "google";

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

/** One capture surfaced in an active briefing. */
export interface BriefingSuggestion {
  filename: string;
  why: string;
  benefit: string;
  where: string;
  applyNow: boolean;
}

/** Structured output from composeBriefing — text for display + parsed suggestions. */
export interface BriefingOutput {
  text: string;
  suggestions: BriefingSuggestion[];
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
