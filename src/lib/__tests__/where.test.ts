import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  matchCapture,
  checkWhere,
  nameCheck,
  whereSection,
  insertWhereSection,
  whereCard,
  whereLine,
  type StoredCodeMap,
  type WhereDeps,
} from "../where";
import type { Scorer } from "../where-score";
import { buildMarkdown } from "../llm";
import type { ExtractedCapture } from "../types";

/**
 * "Where it applies": one LLM call picks a repo and up to 3 files from the
 * user's code maps; xkg then checks every path against the stored map, drops
 * reasons that name functions the file doesn't export, and takes the tier from
 * a scorer, never from the model.
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

const user = { id: 7, llm_api_key: "sk-test", llm_provider: "openai" as const, llm_model: "gpt-6-astra", llm_effort: "medium" as const };

function deps(reply: unknown, over: Partial<WhereDeps> = {}) {
  const complete = vi.fn(async () => (typeof reply === "string" ? reply : JSON.stringify(reply)));
  return { complete, d: { listMaps: async () => [xkg, other], complete, now: () => NOW, ...over } as WhereDeps };
}

const LLM_TS = "src/lib/llm.ts";
const LINKING_TS = "src/lib/linking.ts";
const strongReply = { repo: "xmu-labs/xkg", files: [{ path: LLM_TS, why: "`rankByRelevance` sends the whole index on every call" }], confidence: 0.1 };

describe("matchCapture: when it runs", () => {
  // protects: AC2, no matching on a weak extraction; fails_when: a low-confidence capture gets a section or costs an LLM call; no_claim: none
  it("skips a low-confidence capture without calling the model", async () => {
    const { complete, d } = deps(strongReply);
    expect(await matchCapture(user, { ...capture, lowConfidence: true }, d)).toBeNull();
    expect(await matchCapture(user, { ...capture, coreIdea: "  " }, d)).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });

  // protects: AC3, users without maps keep today's capture file; fails_when: a section is written or the model is called with no maps; no_claim: the card copy
  it("with no maps, says so on the card, writes no section and calls no model", async () => {
    const { complete, d } = deps(strongReply, { listMaps: async () => [] });
    const where = (await matchCapture(user, capture, d))!;
    expect(where.noFit?.reason).toBe("no-maps");
    expect(whereSection(where)).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });

  // protects: a capture that shares no word with any file costs nothing; fails_when: the model is called anyway; no_claim: none
  it("skips the model when no file shares a word with the capture", async () => {
    const { complete, d } = deps(strongReply);
    const where = (await matchCapture(user, { ...capture, inferredTitle: "Pottery", coreIdea: "Glaze kilns reach 1200 degrees.", takeaways: [] }, d))!;
    expect(where.noFit?.reason).toBe("no-shared-words");
    expect(complete).not.toHaveBeenCalled();
  });

  // protects: matching never breaks capture; fails_when: a provider error or a db error throws; no_claim: retries
  it("returns null when the model call or the map lookup fails", async () => {
    expect(await matchCapture(user, capture, deps("", { complete: async () => { throw new Error("429"); } }).d)).toBeNull();
    expect(await matchCapture(user, capture, deps(strongReply, { listMaps: async () => { throw new Error("db down"); } }).d)).toBeNull();
  });

  // protects: AC21, a paid call whose reply can't be read is still counted; fails_when: its tokens are lost, or the reply shows on the card, the file or the tool result; no_claim: none
  it("keeps the cost of a reply it can't read, and shows nothing for it", async () => {
    const complete = vi.fn(async (_s: string, _p: string, onUsage?: (u: { tokensIn: number; tokensOut: number }) => void) => {
      onUsage?.({ tokensIn: 3301, tokensOut: 600 });
      return "I think llm.ts";
    });
    const where = (await matchCapture(user, capture, { ...deps("").d, complete }))!;
    expect(where).toMatchObject({ repo: null, tier: "none", files: [], noFit: { reason: "unreadable" }, tokens: { in: 3301, out: 600 } });
    expect(whereSection(where)).toBeNull();
    expect(whereLine(where)).toBeNull();
    expect(whereCard(where)).toBeNull();
  });

  // protects: the prompt shape (maps first, so repeat matches reuse the cached prefix); fails_when: the capture comes before the maps or a map is missing; no_claim: prompt quality
  it("sends the maps before the capture, in one call", async () => {
    const { complete, d } = deps(strongReply);
    await matchCapture(user, capture, d);
    expect(complete).toHaveBeenCalledTimes(1);
    const prompt = (complete.mock.calls[0] as unknown as [string, string])[1];
    expect(prompt.indexOf("### xmu-labs/xkg")).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf("### acme/notes")).toBeGreaterThan(0);
    expect(prompt.indexOf(capture.inferredTitle)).toBeGreaterThan(prompt.indexOf("### acme/notes"));
  });
});

describe("matchCapture: cost", () => {
  // protects: AC21, each match carries the tokens it used; fails_when: the provider's count is lost, or a match without a model call claims tokens; no_claim: the count is right
  it("keeps the provider's token count when the model was called", async () => {
    const complete = vi.fn(async (_s: string, _p: string, onUsage?: (u: { tokensIn: number; tokensOut: number }) => void) => {
      onUsage?.({ tokensIn: 3301, tokensOut: 142 });
      return JSON.stringify(strongReply);
    });
    const where = (await matchCapture(user, capture, deps(strongReply, { complete }).d))!;
    expect(where.tokens).toEqual({ in: 3301, out: 142 });
  });

  it("keeps the call with unknown counts when the provider sends none", async () => {
    const where = (await matchCapture(user, capture, deps({ repo: null, reason: "nothing" }).d))!;
    expect(where.tier).toBe("none");
    expect(where.tokens).toEqual({ in: null, out: null });
  });

  it("has no tokens when no model was called", async () => {
    const where = (await matchCapture(user, capture, deps(strongReply, { listMaps: async () => [] }).d))!;
    expect(where.tokens).toBeUndefined();
  });
});

describe("checkWhere", () => {
  // protects: AC1, every shown path exists in the stored map; fails_when: an invented path survives; no_claim: the real file still has that content
  it("keeps only paths in the repo's map", () => {
    const out = checkWhere({ repo: "xmu-labs/xkg", files: [{ path: LLM_TS }, { path: "src/lib/memory.ts" }, { path: "src/rag/index.ts" }] }, [xkg]);
    expect(out.files.map((f) => f.path)).toEqual([LLM_TS]);
  });

  // protects: the repo must be one with a map; fails_when: an unmapped or invented repo is suggested; no_claim: none
  it("drops a repo with no map", () => {
    expect(checkWhere({ repo: "acme/invented", files: [{ path: LLM_TS }] }, [xkg]).repo).toBeNull();
    expect(checkWhere({ repo: null, reason: "nothing fits" }, [xkg]).repo).toBeNull();
  });

  // protects: at most 3 files, no repeats; fails_when: 4 files or a duplicate are shown; no_claim: none
  it("keeps at most 3 distinct files", () => {
    const files = ["src/lib/llm.ts", "src/lib/llm.ts", "src/lib/linking.ts", "src/lib/evidence.ts", "src/lib/briefing.ts"].map((p) => ({ path: p }));
    expect(checkWhere({ repo: "xmu-labs/xkg", files }, [xkg]).files.map((f) => f.path)).toEqual([LLM_TS, LINKING_TS, "src/lib/evidence.ts"]);
  });

  // protects: "also fits" repos must be mapped too; fails_when: an unmapped repo or the main repo shows under "Also fits"; no_claim: none
  it("drops also-fits repos without a map, and the main repo", () => {
    const out = checkWhere({ repo: "xmu-labs/xkg", files: [{ path: LLM_TS }], also: [{ repo: "acme/notes" }, { repo: "acme/gone" }, { repo: "xmu-labs/xkg" }] }, [xkg, other]);
    expect(out.also).toEqual(["acme/notes"]);
  });

  // protects: the model's self-score is kept for logging only; fails_when: it is lost or a non-number is kept; no_claim: it means anything
  it("keeps the model's confidence only when it is a number from 0 to 1", () => {
    expect(checkWhere({ ...strongReply, confidence: 0.92 }, [xkg]).modelConf).toBe(0.92);
    expect(checkWhere({ ...strongReply, confidence: "high" }, [xkg]).modelConf).toBeNull();
  });
});

describe("nameCheck", () => {
  const llm = xkg.files.find((f) => f.p === LLM_TS)!;

  // protects: AC16, a reason naming a function the file doesn't export is dropped; fails_when: `notAnExport` survives; no_claim: unquoted names are checked
  it("drops a reason that names a non-exported identifier in backticks", () => {
    expect(nameCheck("`notAnExport` sends the whole index", llm)).toBeUndefined();
    expect(nameCheck("`rankByRelevance()` sends the whole index", llm)).toBe("`rankByRelevance()` sends the whole index");
    expect(nameCheck("the file `src/lib/llm.ts` ranks captures", llm)).toBe("the file `src/lib/llm.ts` ranks captures");
  });

  // protects: AC16 end to end, the file stays when its reason goes; fails_when: the file is dropped with its reason; no_claim: none
  it("keeps the file and drops only its reason", () => {
    const out = checkWhere({ repo: "xmu-labs/xkg", files: [{ path: LLM_TS, why: "`notAnExport` caches memory" }] }, [xkg]);
    expect(out.files).toEqual([{ path: LLM_TS }]);
  });
});

describe("matchCapture: tiers", () => {
  // protects: AC22, the model's confidence never sets the tier; fails_when: 0.99 on a weak file reads Strong, or 0.1 on a strong file reads less; no_claim: the scorer is right
  it("ignores the model's confidence and logs it", async () => {
    const strong = (await matchCapture(user, capture, deps(strongReply).d))!;
    expect(strong.tier).toBe("strong");
    expect(strong.modelConf).toBe(0.1);

    // pin.ts shares no word with the capture and no link to a top file.
    const weak = (await matchCapture(user, capture, deps({ repo: "xmu-labs/xkg", files: [{ path: "src/lib/pin.ts" }], confidence: 0.99 }).d))!;
    expect(["possible", "none"]).toContain(weak.tier);
    expect(weak.modelConf).toBe(0.99);
  });

  // protects: AC23, the scorer is a slot; fails_when: a different scorer can't change the tier, or the default isn't the evidence scorer; no_claim: a TypeSafe scorer works
  it("takes tiers from whatever scorer it is given, and uses the evidence scorer by default", async () => {
    const fixed = (p: number): Scorer => ({ name: "double", score: async (_c, cands) => cands.map((c) => ({ repo: c.repo, path: c.path, p })) });
    expect((await matchCapture(user, capture, deps(strongReply, { scorer: fixed(0.95) }).d))!.tier).toBe("strong");
    const low = (await matchCapture(user, capture, deps(strongReply, { scorer: fixed(0.1) }).d))!;
    expect(low.tier).toBe("none");
    expect(low.noFit?.reason).toBe("weak");
    expect((await matchCapture(user, capture, deps(strongReply).d))!.scorer).toBe("evidence");
  });

  // protects: files below the shown threshold are hidden; fails_when: a file scored under 0.4 is listed; no_claim: none
  it("lists only files scored as at least a possible fit", async () => {
    const scorer: Scorer = { name: "double", score: async (_c, cands) => cands.map((c) => ({ repo: c.repo, path: c.path, p: c.path === LLM_TS ? 0.9 : 0.2 })) };
    const where = (await matchCapture(user, capture, deps({ repo: "xmu-labs/xkg", files: [{ path: LLM_TS }, { path: LINKING_TS }] }, { scorer }).d))!;
    expect(where.files.map((f) => f.path)).toEqual([LLM_TS]);
  });

  // protects: "also fits" carries a tier from the scorer; fails_when: an also repo has no tier, or one scored as no fit is shown; no_claim: none
  it("gives each also-fits repo a tier and hides those with no fit", async () => {
    const reply = { ...strongReply, also: [{ repo: "acme/notes" }] };
    const where = (await matchCapture(user, capture, deps(reply).d))!;
    expect(where.also).toEqual([{ repo: "acme/notes", tier: expect.stringMatching(/strong|possible/) }]);
    const none: Scorer = { name: "double", score: async (_c, cands) => cands.map((c) => ({ repo: c.repo, path: c.path, p: c.repo === "acme/notes" ? 0.1 : 0.9 })) };
    expect((await matchCapture(user, capture, deps(reply, { scorer: none }).d))!.also).toEqual([]);
  });
});

describe("no-fit reasons", () => {
  const nothing = { repo: null, reason: "nothing fits" };
  const old = new Date(NOW.getTime() - 30 * 86_400_000);
  const lineFor = async (maps: StoredCodeMap[], reply: unknown, cap = capture) => {
    const where = (await matchCapture(user, cap, deps(reply, { listMaps: async () => maps }).d))!;
    return { reason: where.noFit?.reason, card: whereCard(where)!.note, section: whereSection(where) };
  };

  // protects: AC20, each reason has its own line on the card; fails_when: two reasons share a line, or a reason has none; no_claim: the copy is the best wording
  it("names one reason per case, each with its own line", async () => {
    const cases = [
      await lineFor([], nothing),
      await lineFor([{ ...xkg, syncedAt: old }], nothing),
      await lineFor([{ ...xkg, truncated: true }], nothing),
      await lineFor([xkg], nothing, { ...capture, inferredTitle: "Pottery", coreIdea: "Glaze kilns reach 1200 degrees.", takeaways: [] }),
      await lineFor([xkg], nothing),
    ];
    expect(cases.map((c) => c.reason)).toEqual(["no-maps", "stale", "truncated", "no-shared-words", "weak"]);
    expect(new Set(cases.map((c) => c.card)).size).toBe(5);
    expect(cases[1]!.card).toContain("xmu-labs/xkg");
    expect(cases[1]!.card).toContain("14 days");
    for (const c of cases.slice(1)) expect(c.section).toBe(`## Where it applies\n${c.card}\n`);
  });

  // protects: precedence when several reasons hold; fails_when: a stale map is reported as a weak match; no_claim: none
  it("prefers stale over truncated over weak", async () => {
    expect((await lineFor([{ ...xkg, syncedAt: old, truncated: true }], nothing)).reason).toBe("stale");
  });
});

describe("whereSection and whereCard", () => {
  // protects: the section format in the capture file; fails_when: the tier, repo, provenance label, map date or a file line is missing; no_claim: rendering in GitHub
  it("writes tier, repo, provenance, map date and one line per file", async () => {
    const reply = { repo: "xmu-labs/xkg", files: [{ path: LLM_TS, why: "`rankByRelevance` sends the whole index on every call" }, { path: LINKING_TS, why: "`notAnExport` runs on empty captures" }], also: [{ repo: "acme/notes" }] };
    const scorer: Scorer = { name: "double", score: async (_c, cands) => cands.map((c) => ({ repo: c.repo, path: c.path, p: c.repo === "acme/notes" ? 0.5 : 0.8 })) };
    const where = (await matchCapture(user, capture, deps(reply, { scorer }).d))!;
    expect(whereSection(where)).toBe(
      "## Where it applies\n" +
        "**Strong fit** · xmu-labs/xkg · from file names, not yet checked in your code · map from 2026-10-29 (a308ab7)\n" +
        "- `src/lib/llm.ts`: `rankByRelevance` sends the whole index on every call\n" +
        "- `src/lib/linking.ts`\n" +
        "Also fits: acme/notes (Possible fit)\n",
    );
  });

  // protects: AC24, the card shows labels, never numbers; fails_when: a score or the model's confidence reaches the browser; no_claim: none
  it("gives the card labels and no numbers", async () => {
    const where = (await matchCapture(user, capture, deps({ ...strongReply, confidence: 0.97 }).d))!;
    const card = whereCard(where)!;
    expect(card.fit).toBe("Strong fit");
    expect(card.repo).toBe("xmu-labs/xkg");
    expect(card.note).toContain("not yet checked in your code");
    const numbers: unknown[] = [];
    JSON.stringify(card, (_k, v) => (typeof v === "number" && numbers.push(v), v));
    expect(numbers).toEqual([]);
  });
});

describe("insertWhereSection", () => {
  const section = "## Where it applies\nNo clear fit in your repos yet: the closest files are only a weak match.\n";

  // protects: the section lands right after Core idea in both capture formats; fails_when: it lands elsewhere or changes other sections; no_claim: none
  it("puts the section right after Core idea", () => {
    const md = buildMarkdown("2026-10-29", capture, "raw");
    const out = insertWhereSection(md, section);
    expect(out).toContain(`## Core idea\n${capture.coreIdea}\n\n${section}\n## Key takeaways`);
    expect(out.replace(`${section}\n`, "")).toBe(md);
    const compact = `# T\n\n## Core idea\nIdea\n\n## Key takeaways\n- a\n`;
    expect(insertWhereSection(compact, section)).toBe(`# T\n\n## Core idea\nIdea\n\n${section}\n## Key takeaways\n- a\n`);
  });

  // protects: files without a Core idea heading are left alone; fails_when: the section is appended somewhere arbitrary; no_claim: none
  it("leaves a file without a Core idea section unchanged", () => {
    expect(insertWhereSection("# T\n\nbody\n", section)).toBe("# T\n\nbody\n");
  });

  // protects: re-running doesn't stack sections; fails_when: a second section is added; no_claim: none
  it("doesn't add a second section", () => {
    const once = insertWhereSection(`## Core idea\nIdea\n\n## Key takeaways\n`, section);
    expect(insertWhereSection(once, section)).toBe(once);
  });

  // Regression: Codex review on #127 — a "Where it applies" heading in the captured source made the check skip the new section
  // protects: capturing a capture (or any source with that heading) still gets its section; fails_when: a heading in the raw text blocks insertion; no_claim: none
  it("adds the section when only the captured source has that heading", () => {
    const md = buildMarkdown("2026-10-29", capture, "# Old capture\n\n## Where it applies\n**Strong fit** · other/repo\n");
    const out = insertWhereSection(md, section);
    expect(out).toContain(`## Core idea\n${capture.coreIdea}\n\n${section}\n## Key takeaways`);
  });
});
