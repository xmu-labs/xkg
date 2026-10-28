import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: vi.fn() }; } }));

const { extractCapture } = await import("../llm");

function openAiResponse(text: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}

const TEXT = "Alerts without a named owner get ignored.\n\nEvery alert needs one person on the hook.";

describe("extractCapture sends a segmented source and checks the claims", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { fetchSpy = vi.spyOn(globalThis, "fetch"); });
  afterEach(() => { fetchSpy.mockRestore(); });

  function sent() {
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    return JSON.parse(init.body as string) as { max_tokens: number; messages: Array<{ content: string }> };
  }

  it("sends source ids, metadata and segments as the user message", async () => {
    fetchSpy.mockResolvedValue(openAiResponse("{}"));
    await extractCapture("k", TEXT, "Alert ownership", "openai", { url: "https://example.com/n" });
    const input = JSON.parse(sent().messages[1]!.content);
    expect(input.sourceId).toMatch(/^src-/);
    expect(input.sourceVersionId).toMatch(/^v-/);
    expect(input.metadata).toEqual({ title: "Alert ownership", url: "https://example.com/n" });
    expect(input.segments.map((s: { segmentId: string }) => s.segmentId)).toEqual(["s1", "s2"]);
  });

  it("leaves room for claims in the answer", async () => {
    fetchSpy.mockResolvedValue(openAiResponse("{}"));
    await extractCapture("k", TEXT, undefined, "openai");
    expect(sent().max_tokens).toBeGreaterThanOrEqual(3000);
  });

  it("returns checked claims and the source they were checked against", async () => {
    fetchSpy.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      const input = JSON.parse(JSON.parse(init!.body as string).messages[1].content);
      const ev = { sourceId: input.sourceId, sourceVersionId: input.sourceVersionId };
      return openAiResponse(JSON.stringify({
        slug: "alerts-need-named-owner", inferredTitle: "Alert ownership", coreIdea: "Alerts need a named owner.",
        takeaways: [], quotes: [], tags: [], appliedTo: null, lowConfidence: false, inferredType: "notes",
        claims: [{ outputPath: "/coreIdea", text: "Alerts need a named owner.", kind: "source_assertion",
          evidence: [{ ...ev, segmentId: "s1", exactQuote: "without a named owner get ignored" }] }],
      }));
    });
    const c = await extractCapture("k", TEXT, undefined, "openai");
    expect(c.claims).toHaveLength(1);
    expect(c.source?.segments).toHaveLength(2);
  });
});
