import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The user's model and effort reach every provider through one adapter. These
// tests pin the request each provider receives, since a wrong reasoning field
// is a 400 from the provider and a missing token headroom is a cut-off answer.
const mockCreate = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
}));

const { generatePlan, resolveLlm, validateLlmModel, llmSettings, REASONING_TOKENS } = await import("../llm");

const CAPTURES = [{ filename: "inbox/x.md", content: "Some capture content" }];

function lastAnthropicRequest(): Record<string, unknown> {
  return mockCreate.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

describe("resolveLlm", () => {
  it("uses the provider default when no model is set", () => {
    expect(resolveLlm("anthropic")).toEqual({ provider: "anthropic", model: "claude-haiku-4-5", effort: null });
    expect(resolveLlm({ provider: "openai", model: "  ", effort: null }).model).toBe("gpt-4o-mini");
  });

  it("keeps the user's model and effort", () => {
    expect(resolveLlm({ provider: "anthropic", model: "claude-opus-5-5", effort: "high" }))
      .toEqual({ provider: "anthropic", model: "claude-opus-5-5", effort: "high" });
  });

  it("drops an effort value it does not know", () => {
    expect(resolveLlm({ provider: "google", effort: "max" as never }).effort).toBeNull();
  });

  it("maps a users row", () => {
    expect(llmSettings({ llm_provider: "google" })).toEqual({ provider: "google", model: null, effort: null });
  });
});

describe("validateLlmModel", () => {
  it("accepts real model IDs", () => {
    for (const id of ["claude-sonnet-5-5", "gpt-4.1", "o4-mini", "gemini-2.5-pro", "ft:gpt-4o-mini:org"]) {
      expect(validateLlmModel(id)).toBeNull();
    }
  });

  it("rejects names that would change the request URL", () => {
    for (const id of ["../models", "a b", "x?key=1", "-flag", "gemini/2.5"]) {
      expect(validateLlmModel(id)).not.toBeNull();
    }
    expect(validateLlmModel("a".repeat(101))).not.toBeNull();
  });
});

describe("Anthropic reasoning", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue({
      content: [{ type: "thinking", thinking: "" }, { type: "text", text: "# Plan" }],
    });
  });

  it("sends no reasoning fields by default", async () => {
    await generatePlan("k", CAPTURES, "ctx");
    const req = lastAnthropicRequest();
    expect(req.thinking).toBeUndefined();
    expect(req.output_config).toBeUndefined();
    expect(req.max_tokens).toBe(3000);
  });

  it("uses a thinking budget on pre-4.6 models", async () => {
    await generatePlan("k", CAPTURES, "ctx", undefined, { provider: "anthropic", effort: "medium" });
    const req = lastAnthropicRequest();
    expect(req.model).toBe("claude-haiku-4-5");
    expect(req.thinking).toEqual({ type: "enabled", budget_tokens: REASONING_TOKENS.medium });
    expect(req.max_tokens).toBe(3000 + REASONING_TOKENS.medium);
  });

  it("uses adaptive thinking and effort on current models", async () => {
    await generatePlan("k", CAPTURES, "ctx", undefined, { provider: "anthropic", model: "claude-opus-5-5", effort: "high" });
    const req = lastAnthropicRequest();
    expect(req.thinking).toEqual({ type: "adaptive" });
    expect(req.output_config).toEqual({ effort: "high" });
    expect(req.max_tokens).toBe(3000 + REASONING_TOKENS.high);
  });

  it("leaves headroom on models that think by default", async () => {
    await generatePlan("k", CAPTURES, "ctx", undefined, { provider: "anthropic", model: "claude-sonnet-5-5" });
    const req = lastAnthropicRequest();
    expect(req.thinking).toBeUndefined();
    expect(req.max_tokens).toBe(3000 + REASONING_TOKENS.medium);
  });

  it("returns the text block, not the thinking block", async () => {
    const plan = await generatePlan("k", CAPTURES, "ctx", undefined, { provider: "anthropic", effort: "low" });
    expect(plan).toBe("# Plan");
  });
});

describe("OpenAI and Google reasoning", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function lastBody(): Record<string, unknown> {
    const [, init] = fetchSpy.mock.calls.at(-1) as [string, RequestInit];
    return JSON.parse(init.body as string) as Record<string, unknown>;
  }

  it("sends reasoning_effort and max_completion_tokens to OpenAI reasoning models", async () => {
    fetchSpy.mockResolvedValue(Response.json({ choices: [{ message: { content: "ok" } }] }));
    await generatePlan("k", CAPTURES, "ctx", undefined, { provider: "openai", model: "o4-mini", effort: "low" });
    const body = lastBody();
    expect(body.model).toBe("o4-mini");
    expect(body.reasoning_effort).toBe("low");
    expect(body.max_completion_tokens).toBe(3000 + REASONING_TOKENS.low);
    expect(body.max_tokens).toBeUndefined();
  });

  it("treats GPT-6 models as reasoning models", async () => {
    fetchSpy.mockResolvedValue(Response.json({ choices: [{ message: { content: "ok" } }] }));
    await generatePlan("k", CAPTURES, "ctx", undefined, { provider: "openai", model: "gpt-6.1-sol", effort: "high" });
    const body = lastBody();
    expect(body.reasoning_effort).toBe("high");
    expect(body.max_completion_tokens).toBe(3000 + REASONING_TOKENS.high);
  });

  it("does not send reasoning_effort to non-reasoning OpenAI models", async () => {
    fetchSpy.mockResolvedValue(Response.json({ choices: [{ message: { content: "ok" } }] }));
    await generatePlan("k", CAPTURES, "ctx", undefined, { provider: "openai", effort: "high" });
    const body = lastBody();
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.max_tokens).toBe(3000);
  });

  it("sends a thinking budget to Gemini 2.5+ and skips thought parts", async () => {
    fetchSpy.mockResolvedValue(Response.json({
      candidates: [{ content: { parts: [{ text: "thinking…", thought: true }, { text: "answer" }] } }],
    }));
    const out = await generatePlan("k", CAPTURES, "ctx", undefined, { provider: "google", model: "gemini-2.5-pro", effort: "medium" });
    const [url] = fetchSpy.mock.calls.at(-1) as [string];
    expect(url).toContain("/models/gemini-2.5-pro:generateContent");
    const config = lastBody().generationConfig as Record<string, unknown>;
    expect(config.thinkingConfig).toEqual({ thinkingBudget: REASONING_TOKENS.medium });
    expect(config.maxOutputTokens).toBe(3000 + REASONING_TOKENS.medium);
    expect(out).toBe("answer");
  });

  it("leaves Gemini 2.5+ thinking room on Default effort without forcing a budget", async () => {
    fetchSpy.mockResolvedValue(Response.json({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }));
    await generatePlan("k", CAPTURES, "ctx", undefined, { provider: "google", model: "gemini-2.5-flash" });
    const config = lastBody().generationConfig as Record<string, unknown>;
    expect(config.thinkingConfig).toBeUndefined();
    expect(config.maxOutputTokens).toBe(3000 + REASONING_TOKENS.medium);
  });

  it("does not send a thinking config to Gemini 2.0", async () => {
    fetchSpy.mockResolvedValue(Response.json({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }));
    await generatePlan("k", CAPTURES, "ctx", undefined, { provider: "google", effort: "high" });
    const config = lastBody().generationConfig as Record<string, unknown>;
    expect(config.thinkingConfig).toBeUndefined();
    expect(config.maxOutputTokens).toBe(3000);
  });
});

describe("OpenAI-compatible providers", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { fetchSpy = vi.spyOn(globalThis, "fetch"); });
  afterEach(() => { fetchSpy.mockRestore(); });

  function lastCall(): [string, Record<string, unknown>, Record<string, string>] {
    const [url, init] = fetchSpy.mock.calls.at(-1) as [string, RequestInit];
    return [url, JSON.parse(init.body as string), init.headers as Record<string, string>];
  }

  it("sends OpenRouter its unified reasoning parameter", async () => {
    fetchSpy.mockResolvedValue(Response.json({ choices: [{ message: { content: "ok" } }] }));
    await generatePlan("sk-or-k", CAPTURES, "ctx", undefined, { provider: "openrouter", model: "qwen/qwen3-235b-a22b", effort: "high" });
    const [url, body, headers] = lastCall();
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(headers.Authorization).toBe("Bearer sk-or-k");
    expect(body.model).toBe("qwen/qwen3-235b-a22b");
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body.max_tokens).toBe(3000 + REASONING_TOKENS.high);
  });

  it("uses each provider's default model and base URL, with no effort parameter", async () => {
    fetchSpy.mockImplementation(async () => Response.json({ choices: [{ message: { content: "ok" } }] }));
    for (const [provider, url, model] of [
      ["xai", "https://api.x.ai/v1/chat/completions", "grok-3-mini"],
      ["deepseek", "https://api.deepseek.com/chat/completions", "deepseek-chat"],
      ["mistral", "https://api.mistral.ai/v1/chat/completions", "mistral-small-latest"],
      ["groq", "https://api.groq.com/openai/v1/chat/completions", "llama-3.3-70b-versatile"],
    ] as const) {
      await generatePlan("k", CAPTURES, "ctx", undefined, { provider, effort: "low" });
      const [calledUrl, body] = lastCall();
      expect(calledUrl).toBe(url);
      expect(body.model).toBe(model);
      expect(body.reasoning).toBeUndefined();
      expect(body.reasoning_effort).toBeUndefined();
    }
  });

  it("drops inline <think> reasoning from the answer", async () => {
    fetchSpy.mockResolvedValue(Response.json({ choices: [{ message: { content: "<think>hmm\nmaybe</think>\n# Plan" } }] }));
    const out = await generatePlan("k", CAPTURES, "ctx", undefined, { provider: "groq", model: "qwen/qwen3-32b" });
    expect(out).toBe("# Plan");
  });
});
