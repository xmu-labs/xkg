import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * One LLM call per capture, so a slow or flaky provider must fail fast and
 * clearly instead of hanging until the serverless timeout. Fetch-based
 * providers get a timeout and one retry on a transient answer; the Anthropic
 * SDK gets the same through its own options.
 */

const anthropicCreate = vi.fn();
const anthropicOptions: unknown[] = [];
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: anthropicCreate };
    constructor(opts: unknown) { anthropicOptions.push(opts); }
  },
}));

const { callLlm, LLM_TIMEOUT_MS } = await import("../llm");

const ok = (text: string) => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
const status = (code: number) => new Response("busy", { status: code });
const call = (llm: Parameters<typeof callLlm>[0]["llm"] = "openai") => callLlm({ llm, apiKey: "k", system: "s", user: "u", maxTokens: 100 });

describe("callLlm against a flaky provider", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { fetchSpy = vi.spyOn(globalThis, "fetch"); vi.useFakeTimers(); });
  afterEach(() => { fetchSpy.mockRestore(); vi.useRealTimers(); });

  // protects: a transient 5xx/429 doesn't fail the capture; fails_when: no second request, or the retry's answer is dropped; no_claim: the wait between tries
  it("retries once on a 5xx and returns the second answer", async () => {
    fetchSpy.mockResolvedValueOnce(status(503)).mockResolvedValueOnce(ok("second"));
    const p = call();
    await vi.runAllTimersAsync();
    expect(await p).toBe("second");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("retries once on a 429", async () => {
    fetchSpy.mockResolvedValueOnce(status(429)).mockResolvedValueOnce(ok("second"));
    const p = call("groq");
    await vi.runAllTimersAsync();
    expect(await p).toBe("second");
  });

  // protects: a bad key or model is reported at once; fails_when: a 4xx is retried; no_claim: none
  it("does not retry a 4xx other than 429", async () => {
    fetchSpy.mockResolvedValueOnce(status(401));
    await expect(call()).rejects.toThrow(/HTTP 401/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // protects: a provider outage ends with one clear error; fails_when: a third request, or the error hides the status; no_claim: none
  it("gives up after the second failure with the provider's status", async () => {
    fetchSpy.mockResolvedValue(status(502));
    const p = call();
    p.catch(() => {});
    await vi.runAllTimersAsync();
    await expect(p).rejects.toThrow(/HTTP 502/);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // protects: a network error is a transient too; fails_when: fetch rejecting once fails the capture; no_claim: none
  it("retries once when the connection drops", async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(ok("second"));
    const p = call("mistral");
    await vi.runAllTimersAsync();
    expect(await p).toBe("second");
  });

  // protects: a hung provider can't hold the capture until the serverless limit; fails_when: the request is sent without a timeout signal; no_claim: none
  it("sends every request with a timeout under the serverless limit", async () => {
    fetchSpy.mockResolvedValueOnce(ok("x"));
    await call();
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(LLM_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    expect(LLM_TIMEOUT_MS).toBeLessThanOrEqual(90_000);
  });

  // protects: the Anthropic SDK path gets the same limits; fails_when: the client is built without a timeout or with the SDK's default retries; no_claim: none
  it("gives the Anthropic client the same timeout and one retry", async () => {
    anthropicCreate.mockResolvedValue({ content: [{ type: "text", text: "{}" }], usage: { input_tokens: 1, output_tokens: 1 } });
    await call("anthropic");
    expect(anthropicOptions.at(-1)).toMatchObject({ apiKey: "k", timeout: LLM_TIMEOUT_MS, maxRetries: 1 });
  });
});
