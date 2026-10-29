import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { matchCapture, whereSection, type StoredCodeMap, type WhereDeps } from "../where";
import { rankFiles } from "../where-rank";
import type { Candidate, Scorer } from "../where-score";
import type { ExtractedCapture } from "../types";

/**
 * With xkg's TypeSafe key set, Jev decides where a capture applies: where-rank's
 * top 15 files per repo go to Jev in one request per repo, and the user's model
 * is not called. Without the key, or when Jev fails, the model picks as before.
 *
 * Not covered: Jev's real answers (stubbed; QA runs it live).
 */

const NOW = new Date("2026-10-29T12:00:00Z");
const fixture = JSON.parse(readFileSync(path.join(__dirname, "fixtures/xkg-map.json"), "utf8")) as { repo: string; head7: string; files: StoredCodeMap["files"] };
const xkg: StoredCodeMap = { repo: fixture.repo, files: fixture.files, head7: fixture.head7, truncated: false, syncedAt: NOW };
const other: StoredCodeMap = { repo: "acme/notes", files: [{ p: "src/memory.ts", e: ["recallMemory"] }, { p: "README.md" }], head7: "abc1234", truncated: false, syncedAt: NOW };

const capture: ExtractedCapture = {
  slug: "llm-memory",
  inferredTitle: "LLM Memory: Trade-offs and Implementation Strategies",
  inferredAuthor: null,
  inferredUrl: null,
  inferredType: "article",
  coreIdea: "LLM memory architecture distinguishes knowledge stored in model weights from memory injected into runtime context, within latency limits.",
  takeaways: [
    "In-context memory places chat history and instructions in the prompt, but longer conversations lose fidelity for mid-context details.",
    "External memory retrieves relevant data into the prompt, but poor chunking introduces irrelevant context and hallucinations.",
  ],
  quotes: [],
  tags: ["llm", "memory"],
  appliedTo: null,
  lowConfidence: false,
};
const text = [capture.inferredTitle, capture.coreIdea, ...capture.takeaways].join("\n");

const user = { id: 7, llm_api_key: "sk-test", llm_provider: "openai" as const, llm_model: "gpt-6.1-terra", llm_effort: "medium" as const };
const LLM_TS = "src/lib/llm.ts";
const modelReply = { repo: "xmu-labs/xkg", files: [{ path: LLM_TS, why: "`rankByRelevance` sends the whole index on every call" }], confidence: 0.9 };

/** A Jev stand-in: p per "repo:path", 0.05 for anything else. */
function jevStub(scores: Record<string, number>): Scorer & { score: ReturnType<typeof vi.fn> } {
  return {
    name: "jev",
    cutoffs: { strong: 0.6, possible: 0.3 },
    score: vi.fn(async (_c: unknown, cands: Candidate[], onUsage?: (u: { tokensIn: number; tokensOut: number }) => void) => {
      onUsage?.({ tokensIn: 6000, tokensOut: 400 });
      return cands.map((c) => ({ repo: c.repo, path: c.path, p: scores[`${c.repo}:${c.path}`] ?? 0.05 }));
    }),
  };
}

function deps(over: Partial<WhereDeps> = {}) {
  const complete = vi.fn(async () => JSON.stringify(modelReply));
  return { complete, d: { listMaps: async () => [xkg, other], complete, now: () => NOW, ...over } as WhereDeps };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("matchCapture with Jev", () => {
  // protects: AC1, the user's model does extraction only; fails_when: the model is called, or Jev gets anything but where-rank's top 15 files per repo with their map entries; no_claim: none
  it("asks Jev about where-rank's top 15 files per repo and never calls the model", async () => {
    const jev = jevStub({ [`xmu-labs/xkg:${LLM_TS}`]: 0.73 });
    const { complete, d } = deps({ jev });
    await matchCapture(user, capture, d);

    expect(complete).not.toHaveBeenCalled();
    expect(jev.score).toHaveBeenCalledTimes(1);
    const sent = jev.score.mock.calls[0]![1] as Candidate[];
    const ranked = rankFiles([xkg, other], text);
    const top = (repo: string) => ranked.filter((r) => r.repo === repo).slice(0, 15).map((r) => `${r.repo}:${r.path}`);
    expect(sent.map((c) => `${c.repo}:${c.path}`)).toEqual([...new Set(ranked.map((r) => r.repo))].flatMap(top));
    expect(new Set(sent.map((c) => c.repo))).toEqual(new Set(["xmu-labs/xkg", "acme/notes"]));
    expect(top("xmu-labs/xkg")).toHaveLength(15);
    for (const c of sent) expect(c.file).toEqual([xkg, other].find((m) => m.repo === c.repo)!.files.find((f) => f.p === c.path));
  });

  // protects: the card shows Jev's best files, best first, with the tier of the best and Jev's cost; fails_when: a file under Possible is shown, more than 3 are shown, the order is wrong, or the result says the model decided; no_claim: the cutoffs are right (XKG-58)
  it("shows up to 3 files at Possible or above, best first, tiered by the best, with Jev's tokens", async () => {
    const jev = jevStub({
      "xmu-labs/xkg:src/lib/linking.ts": 0.35,
      [`xmu-labs/xkg:${LLM_TS}`]: 0.73,
      "xmu-labs/xkg:src/lib/briefing.ts": 0.31,
      "xmu-labs/xkg:src/lib/mcp/handlers.ts": 0.5,
    });
    const where = (await matchCapture(user, capture, deps({ jev }).d))!;
    expect(where).toMatchObject({ repo: "xmu-labs/xkg", tier: "strong", scorer: "jev", modelConf: null, tokens: { in: 6000, out: 400 } });
    expect(where.files.map((f) => f.path)).toEqual([LLM_TS, "src/lib/mcp/handlers.ts", "src/lib/linking.ts"]);
    expect(where.map).toEqual({ date: "2026-10-29", head7: xkg.head7 });
  });

  // protects: a best file between the cutoffs reads as Possible; fails_when: 0.5 reads as Strong or as no fit; no_claim: none
  it("gives Possible when the best file is under Strong", async () => {
    const where = (await matchCapture(user, capture, deps({ jev: jevStub({ [`xmu-labs/xkg:${LLM_TS}`]: 0.5 }) }).d))!;
    expect(where.tier).toBe("possible");
    expect(where.files.map((f) => f.path)).toEqual([LLM_TS]);
  });

  // protects: the reason on the card is checkable, not invented; fails_when: a reason names something the file doesn't export or a word the capture doesn't share; no_claim: that the shared names are why it fits
  it("gives each file the exported names it shares with the capture as its reason", async () => {
    const where = (await matchCapture(user, capture, deps({ jev: jevStub({ [`xmu-labs/xkg:${LLM_TS}`]: 0.73 }) }).d))!;
    const why = where.files[0]!.why!;
    const names = [...why.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    const exports = xkg.files.find((f) => f.p === LLM_TS)!.e!;
    expect(names.length).toBeGreaterThan(0);
    expect(names.length).toBeLessThanOrEqual(3);
    for (const n of names) expect(exports).toContain(n);
    expect(why).toMatch(/^shares names with the capture: /);
    // Five of xkg's files export an "llm" name; llm.ts has more than 3 names
    // sharing rarer words ("model", "prompt", "relevance"), so none of the
    // llm-only names is given.
    expect(names).not.toContain("LLM_PROVIDERS");
    expect(names).not.toContain("verifyLlmKey");
  });

  // protects: another repo's fit is still mentioned; fails_when: a second repo with a Possible file is dropped, or one under Possible is listed; no_claim: none
  it("lists another repo as also fitting when its best file reaches Possible", async () => {
    const where = (await matchCapture(user, capture, deps({ jev: jevStub({ [`xmu-labs/xkg:${LLM_TS}`]: 0.73, "acme/notes:src/memory.ts": 0.4 }) }).d))!;
    expect(where.also).toEqual([{ repo: "acme/notes", tier: "possible" }]);
    const none = (await matchCapture(user, capture, deps({ jev: jevStub({ [`xmu-labs/xkg:${LLM_TS}`]: 0.73, "acme/notes:src/memory.ts": 0.2 }) }).d))!;
    expect(none.also).toEqual([]);
  });

  // protects: a capture that fits nothing says so, and still records Jev's cost; fails_when: a file under Possible is shown or the model is called as a second opinion; no_claim: none
  it("says no clear fit when no file reaches Possible, without calling the model", async () => {
    const { complete, d } = deps({ jev: jevStub({}) });
    const where = (await matchCapture(user, capture, d))!;
    expect(where).toMatchObject({ repo: null, tier: "none", files: [], scorer: "jev", noFit: { reason: "weak", repo: "xmu-labs/xkg" }, tokens: { in: 6000, out: 400 } });
    expect(whereSection(where)).toContain("only a weak match");
    expect(complete).not.toHaveBeenCalled();
  });

  // protects: AC3, Jev failing never changes or blocks the capture; fails_when: a Jev error returns null, throws, or gives a different result than the model path alone; no_claim: none
  it("falls back to the model when Jev fails, with the same result as without Jev", async () => {
    const failing: Scorer = { name: "jev", cutoffs: { strong: 0.6, possible: 0.3 }, score: async () => { throw new Error("jev: HTTP 503"); } };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const withJev = deps({ jev: failing });
    const without = deps({ jev: null });
    const a = await matchCapture(user, capture, withJev.d);
    const b = await matchCapture(user, capture, without.d);
    expect(withJev.complete).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ scorer: "evidence", repo: "xmu-labs/xkg" });
    expect(errors.mock.calls.flat().join(" ")).toContain("jev: HTTP 503");
    errors.mockRestore();
  });

  // protects: no key, no change; fails_when: without TYPESAFE_API_KEY anything but the model path runs, or with it TypeSafe isn't asked; no_claim: none
  it("uses Jev only when xkg's TypeSafe key is set", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const n = Object.keys(JSON.parse(init.body as string).questions).length - 1;
      const answers: Record<string, unknown> = { anything_fits: { type: "noul", noul: 0.8 } };
      for (let i = 0; i < n; i++) answers[`fit_${i}`] = { type: "noul", noul: i === 0 ? 0.7 : 0.1 };
      return new Response(JSON.stringify({ model: "jev", answers, usage: { input_tokens: 10, output_tokens: 1 } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);

    vi.stubEnv("TYPESAFE_API_KEY", "");
    const off = deps();
    expect((await matchCapture(user, capture, off.d))!.scorer).toBe("evidence");
    expect(off.complete).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();

    vi.stubEnv("TYPESAFE_API_KEY", "ts-key");
    const on = deps();
    expect((await matchCapture(user, capture, on.d))!.scorer).toBe("jev");
    expect(on.complete).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((fetch.mock.calls[0]![1].headers as Record<string, string>).Authorization).toBe("Bearer ts-key");
  });
});
