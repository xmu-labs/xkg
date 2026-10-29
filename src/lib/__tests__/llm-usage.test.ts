import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * callLlm reports the tokens each call used, from the provider's own count, so
 * the cost of matching a capture to code can be logged. A provider that sends
 * no count reports nothing rather than a guess.
 */

const mockCreate = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
}));

const { callLlm } = await import("../llm");

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function usageOf(provider: string): Promise<unknown> {
  const onUsage = vi.fn();
  await callLlm({ llm: provider as never, apiKey: "k", system: "s", user: "u", maxTokens: 100, onUsage });
  return onUsage.mock.calls[0]?.[0] ?? null;
}

describe("callLlm token usage", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { fetchSpy = vi.spyOn(globalThis, "fetch"); });
  afterEach(() => { fetchSpy.mockRestore(); mockCreate.mockReset(); });

  // protects: AC21, tokens per match come from the provider; fails_when: usage is dropped or read from the wrong fields; no_claim: billing accuracy
  it("reads OpenAI's prompt and completion tokens", async () => {
    fetchSpy.mockResolvedValue(json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 3301, completion_tokens: 142 } }));
    expect(await usageOf("openai")).toEqual({ tokensIn: 3301, tokensOut: 142 });
  });

  it("reads the same fields from OpenAI-compatible providers", async () => {
    fetchSpy.mockResolvedValue(json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 80, completion_tokens: 9 } }));
    expect(await usageOf("groq")).toEqual({ tokensIn: 80, tokensOut: 9 });
  });

  // Gemini counts thinking apart from the answer; both are output tokens
  it("adds Gemini's thinking tokens to its output", async () => {
    fetchSpy.mockResolvedValue(json({
      candidates: [{ content: { parts: [{ text: "ok" }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 50 },
    }));
    expect(await usageOf("google")).toEqual({ tokensIn: 100, tokensOut: 70 });
  });

  // The system prompt is cached, so most input can be cache reads; all of it is input
  it("counts Anthropic's cached input as input", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 40 },
    });
    expect(await usageOf("anthropic")).toEqual({ tokensIn: 115, tokensOut: 40 });
  });

  it("reports nothing when the provider sends no count", async () => {
    fetchSpy.mockResolvedValue(json({ choices: [{ message: { content: "ok" } }] }));
    expect(await usageOf("openai")).toBeNull();
  });
});
