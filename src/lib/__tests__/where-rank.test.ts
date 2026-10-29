import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { terms, rankFiles, renderMaps, sharedNames, MAP_BUDGET_BYTES, type RepoMap } from "../where-rank";

/**
 * The pre-ranker scores mapped files against a capture with no LLM: BM25 over
 * file names and exported names, then one step along import links. It decides
 * what fits in the matching prompt when the maps are over budget.
 */

const xkg = JSON.parse(readFileSync(path.join(__dirname, "fixtures/xkg-map.json"), "utf8")) as RepoMap;

// A capture about LLM memory (title, core idea, takeaways). Its known targets in
// this repo are src/lib/llm.ts (sends the whole index into every ranking prompt)
// and src/lib/linking.ts (links run on captures with no core idea).
const LLM_MEMORY = `LLM Memory: Trade-offs and Implementation Strategies
LLM memory architecture distinguishes knowledge stored in model weights from memory dynamically injected into runtime context, and balances multiple memory approaches to manage state within latency limits.
- In-context memory places chat history and instructions in the prompt, but its capacity is limited and longer conversations may lose fidelity for earlier or mid-context details.
- External memory retrieves relevant data into the prompt, but poor chunking can introduce irrelevant context and increase the risk of hallucinations or missed details.
- Parametric memory is encoded in model weights during training or fine-tuning and can become outdated after training ends.
- Episodic memory can preserve preferences and past decisions across sessions, but accumulated history can slow responses without a strategy for summarizing or forgetting old data.
- The source recommends RAG for direct questions requiring factual grounding in a large body of static documents.`;

const paths = (r: { path: string }[]) => r.map((f) => f.path);

describe("terms", () => {
  // protects: identifiers match the words people write; fails_when: rankByRelevance or whole_index stays one opaque token; no_claim: stemming quality beyond common suffixes
  it("splits camelCase and snake_case into lowercase words", () => {
    const t = terms("rankByRelevance whole_index");
    for (const w of ["rank", "relevance", "whole", "index"]) expect(t).toContain(terms(w)[0]);
  });

  // protects: word forms match each other; fails_when: "captures" misses a file named capture.ts; no_claim: a full stemmer
  it("gives plural and suffixed forms the same term", () => {
    expect(terms("captures")).toEqual(terms("capture"));
    expect(terms("relevance")).toEqual(terms("relevant"));
    expect(terms("memories")).toEqual(terms("memory"));
    expect(terms("indexes ranking")).toEqual(terms("index rank"));
  });

  // protects: filler words never decide a match; fails_when: "the" or "how" scores a file; no_claim: a complete stopword list
  it("drops filler words and words of two letters or fewer", () => {
    expect(terms("how the of to by an AI")).toEqual([]);
  });
});

describe("sharedNames", () => {
  // protects: a reason built only from facts xkg can check; fails_when: a name the file doesn't export, or one sharing no word with the capture, is given; no_claim: that shared names explain the fit
  it("gives up to 3 exported names that share a word with the capture, in export order", () => {
    const file = { p: "src/lib/llm.ts", e: ["callLlm", "rankByRelevance", "buildIndexRow", "llmSettings", "MAX_TOKENS", "relevanceFloor"] };
    expect(sharedNames(file, "Rank captures by relevance before calling the LLM")).toEqual(["callLlm", "rankByRelevance", "llmSettings"]);
    expect(sharedNames(file, "Pottery glaze")).toEqual([]);
    expect(sharedNames({ p: "README.md" }, "LLM relevance")).toEqual([]);
  });
});

describe("rankFiles", () => {
  // protects: field weights 3/2/1; fails_when: a folder name outranks an exported name; no_claim: the exact BM25 constants
  it("weighs exported names above file names above folders", () => {
    const map: RepoMap = {
      repo: "acme/app",
      files: [{ p: "cache/a.ts" }, { p: "x/cache.ts" }, { p: "x/a.ts", e: ["cache"] }, { p: "x/other.ts" }],
    };
    expect(paths(rankFiles([map], "cache", { links: false }))).toEqual(["x/a.ts", "x/cache.ts", "cache/a.ts"]);
  });

  // protects: rare words count more than common ones; fails_when: a word every file has decides the order; no_claim: tuned IDF
  it("weighs a rare word above a word most files share", () => {
    const map: RepoMap = {
      repo: "acme/app",
      files: [
        { p: "a.ts", e: ["userStore"] },
        { p: "b.ts", e: ["userList"] },
        { p: "c.ts", e: ["userCache"] },
        { p: "d.ts", e: ["invoiceTotal"] },
      ],
    };
    expect(rankFiles([map], "user invoice", { links: false })[0]!.path).toBe("d.ts");
  });

  // protects: a capture sharing no words with any file has no ranking; fails_when: zero-score files come back as matches; no_claim: none
  it("returns only files with a score above zero", () => {
    expect(rankFiles([xkg], "pottery glaze kiln temperatures")).toEqual([]);
  });

  // protects: AC15, the main target ranks near the top from names alone; fails_when: llm.ts falls below 3rd for the LLM memory capture; no_claim: other captures
  it("puts src/lib/llm.ts in the top 3 for the LLM memory capture", () => {
    expect(paths(rankFiles([xkg], LLM_MEMORY)).slice(0, 3)).toContain("src/lib/llm.ts");
    expect(paths(rankFiles([xkg], LLM_MEMORY, { links: false })).slice(0, 3)).toContain("src/lib/llm.ts");
  });

  // protects: AC19, import links reach a target that shares no words; fails_when: linking.ts stays unscored with links, or is scored without them; no_claim: link quality in other repos
  it("reaches src/lib/linking.ts through one import link, and only through it", () => {
    expect(paths(rankFiles([xkg], LLM_MEMORY)).slice(0, 10)).toContain("src/lib/linking.ts");
    expect(paths(rankFiles([xkg], LLM_MEMORY, { links: false }))).not.toContain("src/lib/linking.ts");
  });

  // protects: AC19, hub files (types, db, env) are not promoted by links; fails_when: a hub gets a score it only has through a link; no_claim: the 90th percentile is the best cut
  it("never gives a hub file a score only from a link", () => {
    const indegree = new Map<string, number>();
    for (const f of xkg.files) for (const t of f.i ?? []) indegree.set(t, (indegree.get(t) ?? 0) + 1);
    const degrees = [...indegree.values()].sort((a, b) => a - b);
    const hub = degrees[Math.floor(degrees.length * 0.9)]!;
    const hubs = [...indegree].filter(([, d]) => d >= hub).map(([p]) => p);
    expect(hubs.length).toBeGreaterThan(0);

    const lexical = new Set(paths(rankFiles([xkg], LLM_MEMORY, { links: false })));
    const linked = paths(rankFiles([xkg], LLM_MEMORY));
    for (const h of hubs) if (!lexical.has(h)) expect(linked).not.toContain(h);
  });

  // protects: links only reach one step and score below their seed; fails_when: a file two links away is scored, or a linked file outranks its seed; no_claim: the 0.5 decay is optimal
  it("follows links one step, in both directions, at half the seed's score", () => {
    const map: RepoMap = {
      repo: "acme/app",
      files: [
        { p: "billing.ts", e: ["chargeInvoice"], i: ["mid.ts"] },
        { p: "mid.ts", i: ["far.ts"] },
        { p: "far.ts" },
        { p: "caller.ts", i: ["billing.ts"] },
      ],
    };
    const ranked = rankFiles([map], "invoice");
    const score = (p: string) => ranked.find((r) => r.path === p)?.score;
    expect(score("mid.ts")).toBeCloseTo(score("billing.ts")! / 2);
    expect(score("caller.ts")).toBeCloseTo(score("billing.ts")! / 2);
    expect(score("far.ts")).toBeUndefined();
  });

  // protects: results say which repo a file is in; fails_when: two repos' files merge; no_claim: cross-repo score calibration
  it("ranks every repo and labels each file with its repo", () => {
    const a: RepoMap = { repo: "acme/a", files: [{ p: "x.ts", e: ["parseInvoice"] }, { p: "y.ts" }] };
    const b: RepoMap = { repo: "acme/b", files: [{ p: "x.ts", e: ["invoiceTotal", "invoiceTax"] }, { p: "z.ts" }] };
    const ranked = rankFiles([a, b], "invoice totals");
    expect(ranked.map((r) => `${r.repo}:${r.path}`)).toEqual(["acme/b:x.ts", "acme/a:x.ts"]);
  });
});

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

function bigRepo(n: number): RepoMap {
  return {
    repo: `acme/repo${n}`,
    files: Array.from({ length: 3000 }, (_, i) => ({
      p: `packages/module${i % 40}/src/feature${i}/component${i}.ts`,
      e: [`useFeature${i}`, `Feature${i}Props`, `renderFeature${i}`],
    })),
  };
}

describe("renderMaps", () => {
  // protects: AC14, small maps go in whole, unranked; fails_when: a file is dropped or reordered under budget; no_claim: the model reads them well
  it("sends every file of every map, in stored order, when the maps fit the budget", () => {
    const out = renderMaps([xkg], rankFiles([xkg], LLM_MEMORY));
    const listed = out.split("\n").filter((l) => l && !l.startsWith("### ")).map((l) => l.split(" | ")[0]);
    expect(listed).toEqual(xkg.files.map((f) => f.p));
    expect(out).toContain("src/lib/llm.ts | exports: ");
    expect(out).toContain("### xmu-labs/xkg");
  });

  // protects: AC14, the worst case stays within 12K tokens; fails_when: 5 large maps put more than 48 KB in the prompt; no_claim: token counts per provider
  it("keeps the map section within 48 KB for 5 repos of 3,000 files", () => {
    const maps = [1, 2, 3, 4, 5].map(bigRepo);
    const out = renderMaps(maps, rankFiles(maps, "feature 12 render"));
    expect(bytes(out)).toBeLessThanOrEqual(MAP_BUDGET_BYTES);
    expect(MAP_BUDGET_BYTES).toBe(48 * 1024);
  });

  // protects: over budget, top files keep detail and the rest lose it first; fails_when: the best file is cut to a path, or a scored file is dropped before an unscored one; no_claim: the best possible packing
  it("over budget, keeps exports for top files, paths for the rest, and drops the lowest scores last", () => {
    const maps = [1, 2, 3, 4, 5].map(bigRepo);
    const ranked = rankFiles(maps, "renderFeature1234");
    const out = renderMaps(maps, ranked);
    const top = ranked[0]!;
    expect(out).toContain(`### ${top.repo}\n${top.path} | exports: `);
    const lines = out.split("\n");
    expect(lines.some((l) => l.startsWith("packages/") && !l.includes(" | "))).toBe(true);
    for (const r of ranked.slice(0, 20)) expect(out).toContain(r.path);
  });

  // protects: AC15, a file with no score still reaches the model when it fits; fails_when: ranking hides unscored files under budget; no_claim: none
  it("lists a file with zero score as a path when it fits", () => {
    const out = renderMaps([xkg], rankFiles([xkg], LLM_MEMORY));
    expect(out).toContain("src/lib/linking.ts");
    const small: RepoMap = { repo: "acme/s", files: [{ p: "a.ts", e: ["invoice"] }, { p: "b.ts", e: ["unrelated"] }] };
    const over = renderMaps([small], rankFiles([small], "invoice"), 60);
    expect(over).toBe("### acme/s\na.ts | exports: invoice\nb.ts\n");
  });

  // protects: the order repos appear in over budget; fails_when: a repo with no matching file comes before one that matches; no_claim: none
  it("over budget, puts the repo with the best file first", () => {
    const a: RepoMap = { repo: "acme/a", files: [{ p: "a.ts" }] };
    const b: RepoMap = { repo: "acme/b", files: [{ p: "b.ts", e: ["invoice"] }] };
    const out = renderMaps([a, b], rankFiles([a, b], "invoice"), 40);
    expect(out.indexOf("### acme/b")).toBe(0);
  });
});
