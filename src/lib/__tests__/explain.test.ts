import { describe, it, expect, vi } from "vitest";
import { checkExplain, explainPrompt, setWhyImpact, explainCapture, explainLlm, EXPLAIN_MAX_TOKENS, EXPLAIN_SYSTEM } from "@/lib/explain";
import type { StoredCodeMap } from "@/lib/code-map";

/**
 * Why and After for each file in a capture's "Where it applies": one short
 * call on the user's own model, from the capture and the files' names only,
 * written back into the capture file so it is paid for once.
 */

const FILE = `---
date: 2026-10-30
tags: rag
---

# Why RAG pipelines fail

## Core idea
Most failures come from retrieval, not generation.

## Where it applies
**Strong fit** · acme/app · from file names, not yet checked in your code · map from 2026-10-29 (abc1234)
- \`src/eval/recall.ts\`: shares names with the capture: \`recallAtK\`
- \`src/rerank.ts\`
Also fits: acme/web (Possible fit)

## Takeaways
- Measure recall@k before tuning prompts.
- Chunk by semantic boundary.

## Source
- \`src/eval/recall.ts\`: this line is in the source, not the section
`;

const MAP: StoredCodeMap = {
  repo: "acme/app",
  head7: "abc1234",
  files: [
    { p: "src/eval/recall.ts", e: ["recallAtK", "evalSuite"] },
    { p: "src/rerank.ts", e: ["rerank"] },
    { p: "src/other.ts", e: ["other"] },
  ],
  syncedAt: new Date("2026-10-29"),
} as StoredCodeMap;

const reply = (files: unknown) => JSON.stringify({ files });

describe("explainPrompt", () => {
  it("gives the capture and each file's path and exported names, never code", () => {
    const text = explainPrompt(
      { title: "Why RAG pipelines fail", coreIdea: "Most failures come from retrieval.", takeaways: ["Measure recall@k.", "Chunk.", "Re-rank.", "Fourth."] },
      "acme/app",
      [MAP.files[0]!, { p: "src/missing.ts" }],
    );
    expect(text).toContain("Why RAG pipelines fail");
    expect(text).toContain("Most failures come from retrieval.");
    expect(text).toContain("src/eval/recall.ts (exports: recallAtK, evalSuite)");
    expect(text).toContain("src/missing.ts");
    expect(text).toContain("Re-rank.");
    expect(text).not.toContain("Fourth.");
  });

  it("adds each file's one-line summary from the code map when there is one", () => {
    const text = explainPrompt(
      { title: "T", coreIdea: null, takeaways: [] },
      "acme/app",
      [{ p: "src/rerank.ts", e: ["rerank"], d: "Re-orders retrieved chunks by relevance" }, { p: "src/plain.ts" }],
    );
    expect(text).toContain("- src/rerank.ts: Re-orders retrieved chunks by relevance (exports: rerank)");
    expect(text).toMatch(/^- src\/plain\.ts$/m);
  });
});

describe("EXPLAIN_SYSTEM", () => {
  it("asks for the impact: the result once applied, outcome first, 20 words or fewer", () => {
    expect(EXPLAIN_SYSTEM).toContain('"impact"');
    expect(EXPLAIN_SYSTEM).toMatch(/impact: the result once the capture is applied/);
    expect(EXPLAIN_SYSTEM).toContain("20 words or fewer");
    expect(EXPLAIN_SYSTEM).not.toMatch(/"after"/);
  });
});

describe("checkExplain", () => {
  const files = [MAP.files[0]!, MAP.files[1]!];

  it("keeps a why and an impact for each asked file", () => {
    const out = checkExplain(reply([
      { path: "src/eval/recall.ts", why: "Measures retrieval, the stage that fails most", impact: "Recall@k is checked before prompts change" },
    ]), files);
    expect(out).toEqual([{ path: "src/eval/recall.ts", why: "Measures retrieval, the stage that fails most", impact: "Recall@k is checked before prompts change" }]);
  });

  it("drops files it wasn't asked about and entries with no why or impact", () => {
    const out = checkExplain(reply([
      { path: "src/other.ts", why: "x", impact: "y" },
      { path: "src/rerank.ts", why: "", impact: "Results are re-ranked" },
      { path: "src/eval/recall.ts", why: "Measures retrieval", impact: "  " },
    ]), files);
    expect(out).toEqual([]);
  });

  it("cuts why to 12 words and impact to 20", () => {
    const long = Array.from({ length: 25 }, (_, i) => `w${i}`).join(" ");
    const [f] = checkExplain(reply([{ path: "src/rerank.ts", why: long, impact: long }]), files);
    expect(f!.why.split(" ")).toHaveLength(12);
    expect(f!.impact.split(" ")).toHaveLength(20);
  });

  it("accepts a reply that still uses the old after key", () => {
    const out = checkExplain(reply([{ path: "src/rerank.ts", why: "Orders chunks", after: "Answers cite the right chunk" }]), files);
    expect(out).toEqual([{ path: "src/rerank.ts", why: "Orders chunks", impact: "Answers cite the right chunk" }]);
  });

  it("drops a line that names a function the file doesn't export", () => {
    const out = checkExplain(reply([{ path: "src/rerank.ts", why: "`madeUp` sorts results", impact: "`rerank` uses recall" }]), files);
    expect(out).toEqual([]);
  });

  it("puts lines on one line and drops the separator the file uses", () => {
    const [f] = checkExplain(reply([{ path: "src/rerank.ts", why: "Sorts\nresults · Impact: x", impact: "Better order" }]), files);
    expect(f!.why).toBe("Sorts results - Impact: x");
  });

  it("reads the entries of a reply with a stray field", () => {
    const raw = '{"files":[{"path":"src/rerank.ts","why":"Orders \\"chunks\\"","after":"Better order",""},{"path":"src/eval/recall.ts","why":"a","after":"b"}]}';
    expect(checkExplain(raw, files)).toEqual([
      { path: "src/rerank.ts", why: 'Orders "chunks"', impact: "Better order" },
      { path: "src/eval/recall.ts", why: "a", impact: "b" },
    ]);
  });

  it("reads a fenced reply and gives nothing for an unreadable one", () => {
    expect(checkExplain("```json\n" + reply([{ path: "src/rerank.ts", why: "a", impact: "b" }]) + "\n```", files)).toHaveLength(1);
    expect(checkExplain("not json", files)).toEqual([]);
    expect(checkExplain(reply("nope"), files)).toEqual([]);
  });
});

describe("setWhyImpact", () => {
  it("writes why and impact on the section's file lines only", () => {
    const out = setWhyImpact(FILE, [{ path: "src/eval/recall.ts", why: "Measures retrieval", impact: "Recall is checked first" }]);
    expect(out).toContain("- `src/eval/recall.ts`: Measures retrieval · Impact: Recall is checked first\n- `src/rerank.ts`\nAlso fits");
    expect(out).toContain("## Source\n- `src/eval/recall.ts`: this line is in the source, not the section");
    expect(out.replace("Measures retrieval · Impact: Recall is checked first", "shares names with the capture: `recallAtK`")).toBe(FILE);
  });

  it("leaves a file with no section unchanged", () => {
    const plain = FILE.replace(/## Where it applies[\s\S]*?\n\n## Takeaways/, "## Takeaways");
    expect(setWhyImpact(plain, [{ path: "src/rerank.ts", why: "a", impact: "b" }])).toBe(plain);
  });
});

describe("explainCapture", () => {
  const user = { id: 7, llm_api_key: "sk", llm_provider: "openai", llm_model: "gpt-6.1-terra", llm_effort: null } as never;

  it("asks the model once, capped, and returns the checked lines with the updated file", async () => {
    const complete = vi.fn(async (_s: string, _p: string, maxTokens: number, onUsage?: (u: { tokensIn: number; tokensOut: number }) => void) => {
      expect(maxTokens).toBe(EXPLAIN_MAX_TOKENS);
      onUsage?.({ tokensIn: 420, tokensOut: 61 });
      return reply([
        { path: "src/eval/recall.ts", why: "Measures retrieval", impact: "Recall is checked first" },
        { path: "src/rerank.ts", why: "Orders retrieved chunks", impact: "Better chunks reach the prompt" },
      ]);
    });
    const out = await explainCapture(user, FILE, { complete, listMaps: async () => [MAP] });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(EXPLAIN_MAX_TOKENS).toBeLessThanOrEqual(260);
    expect(out!.files.map((f) => f.impact)).toEqual(["Recall is checked first", "Better chunks reach the prompt"]);
    expect(out!.tokens).toEqual({ in: 420, out: 61 });
    expect(out!.markdown).toContain("- `src/rerank.ts`: Orders retrieved chunks · Impact: Better chunks reach the prompt");
  });

  it("doesn't call the model when every file already has an impact", async () => {
    const done = setWhyImpact(FILE, [
      { path: "src/eval/recall.ts", why: "a", impact: "b" },
      { path: "src/rerank.ts", why: "c", impact: "d" },
    ]);
    const complete = vi.fn();
    const out = await explainCapture(user, done, { complete, listMaps: async () => [MAP] });
    expect(complete).not.toHaveBeenCalled();
    expect(out!.files).toEqual([{ path: "src/eval/recall.ts", why: "a", impact: "b" }, { path: "src/rerank.ts", why: "c", impact: "d" }]);
    expect(out!.markdown).toBe(done);
  });

  it("rewrites legacy After lines once and saves them as Impact", async () => {
    const legacy = FILE
      .replace("- `src/eval/recall.ts`: shares names with the capture: `recallAtK`", "- `src/eval/recall.ts`: Measures retrieval · After: `recallAtK` runs first")
      .replace("- `src/rerank.ts`\n", "- `src/rerank.ts`: Orders chunks · After: `rerank` sorts by score\n");
    const complete = vi.fn(async () => reply([
      { path: "src/eval/recall.ts", why: "Measures retrieval", impact: "Retrieval failures show up before users see wrong answers" },
      { path: "src/rerank.ts", why: "Orders chunks", impact: "Answers use the most relevant chunks" },
    ]));
    const out = await explainCapture(user, legacy, { complete, listMaps: async () => [MAP] });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(out!.markdown).toContain("- `src/rerank.ts`: Orders chunks · Impact: Answers use the most relevant chunks");
    expect(out!.markdown).not.toContain("· After:");
    const again = vi.fn();
    await explainCapture(user, out!.markdown, { complete: again, listMaps: async () => [MAP] });
    expect(again).not.toHaveBeenCalled();
  });

  it("keeps the legacy line when the rewrite fails", async () => {
    const legacy = FILE.replace("- `src/rerank.ts`\n", "- `src/rerank.ts`: Orders chunks · After: sorted\n");
    expect(await explainCapture(user, legacy, { complete: async () => { throw new Error("down"); }, listMaps: async () => [MAP] })).toBeNull();
  });

  it("works without a map: paths only", async () => {
    const complete = vi.fn(async (_s: string, p: string) => {
      expect(p).toContain("src/rerank.ts");
      return reply([{ path: "src/rerank.ts", why: "Orders chunks", impact: "Better chunks" }]);
    });
    const out = await explainCapture(user, FILE, { complete, listMaps: async () => [] });
    expect(out!.files.find((f) => f.path === "src/rerank.ts")?.impact).toBe("Better chunks");
  });

  it("is null when the reply has nothing usable, and keeps a partial answer", async () => {
    expect(await explainCapture(user, FILE, { complete: async () => "{\"files\":[", listMaps: async () => [MAP] })).toBeNull();
    const part = await explainCapture(user, FILE, {
      complete: async () => reply([{ path: "src/rerank.ts", why: "Orders chunks", impact: "Better chunks" }]),
      listMaps: async () => [MAP],
    });
    expect(part!.files).toEqual([{ path: "src/rerank.ts", why: "Orders chunks", impact: "Better chunks" }]);
  });

  it("is null with no fit, no key, or a failed call", async () => {
    const noFit = FILE.replace(/\*\*Strong fit\*\*[^\n]*\n- [^\n]*\n- [^\n]*\nAlso[^\n]*\n/, "No clear fit in your repos yet.\n");
    expect(await explainCapture(user, noFit, { complete: vi.fn(), listMaps: async () => [MAP] })).toBeNull();
    expect(await explainCapture({ ...(user as object), llm_api_key: null } as never, FILE, { complete: vi.fn(), listMaps: async () => [MAP] })).toBeNull();
    expect(await explainCapture(user, FILE, { complete: async () => { throw new Error("down"); }, listMaps: async () => [MAP] })).toBeNull();
  });
});

describe("explainLlm", () => {
  it("keeps the user's model and lowers the effort only where it is safe", () => {
    expect(explainLlm({ llm_provider: "openai", llm_model: "gpt-6.1-terra", llm_effort: null } as never)).toEqual({ provider: "openai", model: "gpt-6.1-terra", effort: "low" });
    expect(explainLlm({ llm_provider: "anthropic", llm_model: "m", llm_effort: "high" } as never)).toEqual({ provider: "anthropic", model: "m", effort: "low" });
    expect(explainLlm({ llm_provider: "anthropic", llm_model: "m", llm_effort: null } as never)).toEqual({ provider: "anthropic", model: "m", effort: null });
  });
});
