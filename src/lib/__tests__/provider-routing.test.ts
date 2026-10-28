import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Anthropic path is covered by generatePlan.test.ts
// (which mocks @anthropic-ai/sdk). Here we verify the OpenAI and Google REST
// paths in the provider adapter by mocking fetch and calling a public function.
const mockCreate = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
}));

const { generatePlan } = await import("../llm");

const CAPTURES = [{ filename: "inbox/x.md", content: "Some capture content" }];

function openAiResponse(text: string) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: text } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function googleResponse(text: string) {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("provider routing", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("routes to the OpenAI chat completions endpoint when provider is 'openai'", async () => {
    fetchSpy.mockResolvedValue(openAiResponse("# Plan via OpenAI"));

    const result = await generatePlan("sk-test", CAPTURES, "ctx", undefined, "openai");

    expect(result).toBe("# Plan via OpenAI");
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("api.openai.com/v1/chat/completions");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-test");
    const body = JSON.parse(init.body as string) as { messages: Array<{ role: string }>; max_tokens: number };
    expect(body.messages[0]?.role).toBe("system");
    expect(body.messages[1]?.role).toBe("user");
    expect(body.max_tokens).toBe(3000);
  });

  it("routes to the Google generateContent endpoint when provider is 'google'", async () => {
    fetchSpy.mockResolvedValue(googleResponse("# Plan via Gemini"));

    const result = await generatePlan("g-test", CAPTURES, "ctx", undefined, "google");

    expect(result).toBe("# Plan via Gemini");
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("generativelanguage.googleapis.com");
    expect(url).toContain(":generateContent");
    expect(url).toContain("key=g-test");
    const body = JSON.parse(init.body as string) as { systemInstruction: unknown; contents: unknown };
    expect(body.systemInstruction).toBeDefined();
    expect(body.contents).toBeDefined();
  });

  it("does NOT call fetch when provider is 'anthropic' (uses the SDK)", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "# Plan via Claude" }] });

    const result = await generatePlan("ak-test", CAPTURES, "ctx", undefined, "anthropic");

    expect(result).toBe("# Plan via Claude");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws a labeled error when the OpenAI endpoint returns non-2xx", async () => {
    fetchSpy.mockResolvedValue(new Response("rate limited", { status: 429 }));

    await expect(generatePlan("sk-test", CAPTURES, "ctx", undefined, "openai")).rejects.toThrow(/llm:openai.*429/);
  });
});
