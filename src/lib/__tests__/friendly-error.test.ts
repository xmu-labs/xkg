import { describe, it, expect } from "vitest";
import { llmErrorMessage, llmErrorLink, githubSaveMessage } from "../friendly-error";
import { LLM_PROVIDERS, PROVIDERS } from "../providers";

/**
 * Capture failures reach the person as one plain sentence that says what to
 * do, never a provider's or GitHub's raw JSON (XKG-139). Details stay in the
 * server log.
 */

const openaiNoCredits = new Error(
  `[llm:openai] HTTP 429 — { "error": { "message": "You have no credits remaining.", "type": "insufficient_quota", "param": null, "code": "credit_balance_exhausted" } }`,
);

describe("llmErrorMessage", () => {
  // protects: the exact error Soph hit; fails_when: raw JSON or no next step reaches the page; no_claim: none
  it("says the key has no credits left and where to fix it", () => {
    const msg = llmErrorMessage(openaiNoCredits, "openai");
    expect(msg).toBe("Your OpenAI key has no credits left. Add credits with OpenAI, or pick another model in Settings → AI model.");
  });

  // protects: every provider's "out of money" reads the same; fails_when: Anthropic's 400 credit error or a 402 shows raw; no_claim: none
  it.each([
    ["anthropic", Object.assign(new Error(`400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}`), { status: 400 }), "Anthropic"],
    ["openrouter", new Error(`[llm:openrouter] HTTP 402 — {"error":{"message":"Insufficient credits"}}`), "OpenRouter"],
    ["google", new Error(`[llm:google] HTTP 429 — {"error":{"status":"RESOURCE_EXHAUSTED","message":"You exceeded your current quota, please check your plan and billing details."}}`), "Google Gemini"],
  ] as const)("%s: no credits", (provider, err, label) => {
    expect(llmErrorMessage(err, provider)).toBe(`Your ${label} key has no credits left. Add credits with ${label}, or pick another model in Settings → AI model.`);
  });

  // protects: a bad key points at Settings; fails_when: a 401 reads as an outage; no_claim: none
  it("a refused key points at Settings", () => {
    const msg = llmErrorMessage(new Error(`[llm:openai] HTTP 401 — {"error":{"message":"Incorrect API key provided"}}`), "openai");
    expect(msg).toBe("OpenAI didn't accept your API key. Paste a new one in Settings → AI model.");
  });

  // protects: a plain rate limit is not called "no credits"; fails_when: a 429 without a quota word says credits; no_claim: none
  it("a rate limit says wait", () => {
    const msg = llmErrorMessage(new Error(`[llm:groq] HTTP 429 — {"error":{"message":"Rate limit reached for requests"}}`), "groq");
    expect(msg).toBe("Groq is limiting how fast your key can make calls. Wait a minute and try again.");
  });

  // protects: an unknown model points at Settings; fails_when: a 404 reads as an outage; no_claim: none
  it("an unknown model points at Settings", () => {
    const msg = llmErrorMessage(new Error(`[llm:openai] HTTP 404 — {"error":{"code":"model_not_found"}}`), "openai");
    expect(msg).toBe("OpenAI doesn't offer the model you picked. Pick another in Settings → AI model.");
  });

  // protects: an outage says try again; fails_when: a 503 shows raw; no_claim: none
  it("a provider outage says try again", () => {
    const msg = llmErrorMessage(new Error("[llm:openai] HTTP 503"), "openai");
    expect(msg).toBe("OpenAI is having trouble right now. Try again in a minute, or pick another model in Settings → AI model.");
  });

  // protects: a timeout is named; fails_when: the timeout reads as an outage; no_claim: none
  it("a timeout says pick a faster model", () => {
    const msg = llmErrorMessage(new Error("[llm] No answer from the provider after 60s."), "mistral");
    expect(msg).toBe("Mistral didn't answer within a minute. Try again, or pick a faster model in Settings → AI model.");
  });

  // protects: any other HTTP error is still a sentence; fails_when: a 400 body reaches the page; no_claim: none
  it("any other provider error is a sentence with the status only", () => {
    const msg = llmErrorMessage(new Error(`[llm:xai] HTTP 400 — {"error":"bad"}`), "xai");
    expect(msg).toBe("xAI Grok returned an error (HTTP 400). Try again, or check Settings → AI model.");
  });

  // protects: messages that are already plain stay as they are; fails_when: the invalid-JSON message is rewritten; no_claim: none
  it("keeps a message that is already plain", () => {
    const plain = "Failed to parse LLM response — extraction returned invalid JSON.";
    expect(llmErrorMessage(new Error(plain), "openai")).toBe(plain);
  });
});

describe("llmErrorLink", () => {
  // protects: XKG-143, an out-of-credits error links straight to billing; fails_when: no link or the keys page is linked; no_claim: the URL is live
  it("links the provider's billing page when the key has no credits", () => {
    expect(llmErrorLink(openaiNoCredits, "openai")).toEqual({ label: "Open OpenAI billing", url: PROVIDERS.openai.billingUrl });
  });

  // protects: every provider has a billing page; fails_when: a provider is added without one; no_claim: none
  it.each(LLM_PROVIDERS)("%s has an https billing URL", (provider) => {
    expect(PROVIDERS[provider].billingUrl).toMatch(/^https:\/\//);
  });

  // protects: only credit errors get a billing link; fails_when: a bad key or outage links billing; no_claim: none
  it.each([
    new Error(`[llm:openai] HTTP 401 — {"error":{"message":"Incorrect API key provided"}}`),
    new Error("[llm:openai] HTTP 503"),
    new Error(`[llm:groq] HTTP 429 — {"error":{"message":"Rate limit reached for requests"}}`),
    new Error("Failed to parse LLM response — extraction returned invalid JSON."),
  ])("no link for other errors (%#)", (err) => {
    expect(llmErrorLink(err, "openai")).toBeNull();
  });
});

describe("githubSaveMessage", () => {
  // protects: an outage says try again; fails_when: GitHub's JSON reaches the page; no_claim: none
  it("an outage says try again", () => {
    const err = Object.assign(new Error(`GitHub PUT inbox/x.md: HTTP 502 — {"message":"Server Error"}`), { status: 502 });
    expect(githubSaveMessage(err, "o/r")).toBe("GitHub didn't save the capture (HTTP 502). Try again in a minute.");
  });

  // protects: lost access says what to do; fails_when: a 403/404 reads as an outage; no_claim: none
  it.each([401, 403, 404])("HTTP %i names the repo and says sign in again", (status) => {
    const err = Object.assign(new Error(`GitHub PUT inbox/x.md: HTTP ${status} — {}`), { status });
    expect(githubSaveMessage(err, "o/r")).toBe("xkg can't write to your repo o/r. Check that it still exists, then sign out and sign in again.");
  });

  // protects: a dropped connection is still a sentence; fails_when: a TypeError message shows; no_claim: none
  it("a dropped connection says try again", () => {
    expect(githubSaveMessage(new TypeError("fetch failed"), "o/r")).toBe("Couldn't reach GitHub to save the capture. Try again in a minute.");
  });
});
