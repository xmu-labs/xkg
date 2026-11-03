import { PROVIDERS, isLlmProvider } from "@/lib/providers";

/**
 * Capture failures reach the person as one plain sentence that says what to do
 * next, never a provider's or GitHub's raw JSON. The full error stays in the
 * server log, where it is useful.
 */

const SETTINGS = "Settings → AI model";

/** The HTTP status in an error: its `status` field, or "HTTP 429" / a leading "400 " in the message. */
function statusOf(err: unknown, message: string): number | null {
  const own = (err as { status?: unknown } | null)?.status;
  if (typeof own === "number") return own;
  const m = /HTTP (\d{3})\b/.exec(message) ?? /^(\d{3})\b/.exec(message);
  return m ? Number(m[1]) : null;
}

/** True when the error came from a provider call (our "[llm…]" prefix, or an SDK error with a status). */
function isProviderError(err: unknown, message: string): boolean {
  return message.startsWith("[llm") || typeof (err as { status?: unknown } | null)?.status === "number";
}

/** True when a provider error says the key has run out of credits or quota. */
function isNoCredits(err: unknown, message: string): boolean {
  if (!isProviderError(err, message)) return false;
  return statusOf(err, message) === 402 || NO_CREDITS.test(message);
}

const NO_CREDITS = /insufficient_quota|credit_balance|credit balance|insufficient credits|no credits|exceeded your current quota|billing/i;

/** A link that helps fix a provider error: today only "add credits" for a key that ran out. */
export function llmErrorLink(err: unknown, provider: string): { label: string; url: string } | null {
  const message = err instanceof Error ? err.message : String(err);
  if (!isLlmProvider(provider) || !isNoCredits(err, message)) return null;
  const info = PROVIDERS[provider];
  return { label: `Open ${info.label} billing`, url: info.billingUrl };
}

/** A provider error as a sentence: no credits, bad key, rate limit, unknown model, outage, timeout. */
export function llmErrorMessage(err: unknown, provider: string): string {
  const message = err instanceof Error ? err.message : String(err);
  if (!isProviderError(err, message)) return message;
  const name = isLlmProvider(provider) ? PROVIDERS[provider].label : "Your AI provider";

  if (/No answer from the provider|timed out/i.test(message)) {
    return `${name} didn't answer within a minute. Try again, or pick a faster model in ${SETTINGS}.`;
  }
  const status = statusOf(err, message);
  if (isNoCredits(err, message)) {
    return `Your ${name} key has no credits left. Add credits with ${name}, or pick another model in ${SETTINGS}.`;
  }
  if (status === 401 || status === 403 || /invalid.{0,10}api.?key|incorrect api key|api key not valid/i.test(message)) {
    return `${name} didn't accept your API key. Paste a new one in ${SETTINGS}.`;
  }
  if (status === 429) return `${name} is limiting how fast your key can make calls. Wait a minute and try again.`;
  if (status === 404 || /model_not_found|model.{0,20}(not found|does not exist)/i.test(message)) {
    return `${name} doesn't offer the model you picked. Pick another in ${SETTINGS}.`;
  }
  if (status !== null && status >= 500) {
    return `${name} is having trouble right now. Try again in a minute, or pick another model in ${SETTINGS}.`;
  }
  return `${name} returned an error${status ? ` (HTTP ${status})` : ""}. Try again, or check ${SETTINGS}.`;
}

/** A failed save of the capture file as a sentence. */
export function githubSaveMessage(err: unknown, repo: string): string {
  const message = err instanceof Error ? err.message : String(err);
  const status = statusOf(err, message);
  if (status === 401 || status === 403 || status === 404) {
    return `xkg can't write to your repo ${repo}. Check that it still exists, then sign out and sign in again.`;
  }
  if (status === null) return "Couldn't reach GitHub to save the capture. Try again in a minute.";
  return `GitHub didn't save the capture (HTTP ${status}). Try again in a minute.`;
}
