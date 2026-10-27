/**
 * Every LLM provider a user can bring a key for. Client-safe (no SDKs): the
 * onboarding page, Settings and the server adapter all read this one list.
 *
 * Anthropic, OpenAI and Google have their own adapters. The rest speak the
 * OpenAI chat-completions API at `baseUrl`, so adding one is a new entry here.
 * OpenRouter covers everything else (Llama, Qwen, Kimi…) with a single key.
 */

export type LlmProvider =
  | "anthropic"
  | "openai"
  | "google"
  | "openrouter"
  | "xai"
  | "deepseek"
  | "mistral"
  | "groq";

export interface ProviderInfo {
  label: string;
  /** What a key looks like, for the input placeholder. */
  placeholder: string;
  keysUrl: string;
  /** The picker's list; the first is xkg's default (fast and cheap). */
  models: readonly [string, ...string[]];
  /** OpenAI-compatible chat-completions base URL; absent for native adapters. */
  baseUrl?: string;
  /** Authenticated GET that answers 401 for a bad key. Defaults to `${baseUrl}/models`. */
  verifyUrl?: string;
}

export const PROVIDERS: Record<LlmProvider, ProviderInfo> = {
  anthropic: {
    label: "Anthropic",
    placeholder: "sk-ant-...",
    keysUrl: "https://console.anthropic.com/settings/keys",
    models: ["claude-haiku-4-5", "claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"],
  },
  openai: {
    label: "OpenAI",
    placeholder: "sk-...",
    keysUrl: "https://platform.openai.com/api-keys",
    models: ["gpt-4o-mini", "gpt-4.1", "gpt-5-mini", "gpt-5", "o4-mini"],
  },
  google: {
    label: "Google Gemini",
    placeholder: "AIza...",
    keysUrl: "https://aistudio.google.com/app/apikey",
    models: ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-2.5-pro"],
  },
  openrouter: {
    label: "OpenRouter",
    placeholder: "sk-or-...",
    keysUrl: "https://openrouter.ai/settings/keys",
    models: [
      "openai/gpt-4o-mini",
      "anthropic/claude-sonnet-4.5",
      "google/gemini-2.5-flash",
      "meta-llama/llama-3.3-70b-instruct",
      "qwen/qwen3-235b-a22b",
      "deepseek/deepseek-chat",
    ],
    baseUrl: "https://openrouter.ai/api/v1",
    // Its /models list is public, so it can't tell a good key from a bad one.
    verifyUrl: "https://openrouter.ai/api/v1/key",
  },
  xai: {
    label: "xAI Grok",
    placeholder: "xai-...",
    keysUrl: "https://console.x.ai",
    models: ["grok-3-mini", "grok-4"],
    baseUrl: "https://api.x.ai/v1",
  },
  deepseek: {
    label: "DeepSeek",
    placeholder: "sk-...",
    keysUrl: "https://platform.deepseek.com/api_keys",
    models: ["deepseek-chat", "deepseek-reasoner"],
    baseUrl: "https://api.deepseek.com",
  },
  mistral: {
    label: "Mistral",
    placeholder: "Your Mistral key",
    keysUrl: "https://console.mistral.ai/api-keys",
    models: ["mistral-small-latest", "mistral-medium-latest", "mistral-large-latest"],
    baseUrl: "https://api.mistral.ai/v1",
  },
  groq: {
    label: "Groq",
    placeholder: "gsk_...",
    keysUrl: "https://console.groq.com/keys",
    models: ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "qwen/qwen3-32b"],
    baseUrl: "https://api.groq.com/openai/v1",
  },
};

export const LLM_PROVIDERS = Object.keys(PROVIDERS) as LlmProvider[];

export function isLlmProvider(value: unknown): value is LlmProvider {
  return typeof value === "string" && value in PROVIDERS;
}
