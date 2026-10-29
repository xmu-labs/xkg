import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { StoredCodeMap } from "../code-map";
import type { ExtractedCapture } from "../types";

/** On capture, a GitHub map older than 7 days is read again before matching (best-effort). */

const listCodeMaps = vi.fn();
const saveCodeMap = vi.fn();
vi.mock("../db", () => ({
  listCodeMaps: (...a: unknown[]) => listCodeMaps(...a),
  saveCodeMap: (...a: unknown[]) => saveCodeMap(...a),
}));

const { matchCapture } = await import("../where");

const NOW = new Date("2026-10-29T12:00:00Z");
const stale: StoredCodeMap = { repo: "acme/shop", files: [{ p: "docs/old-notes.md" }], head7: null, truncated: false, source: "github", syncedAt: new Date(NOW.getTime() - 8 * 86_400_000) };
const capture: ExtractedCapture = {
  slug: "cache-policy", inferredTitle: "Cache policy for checkout pages", inferredAuthor: null, inferredUrl: null, inferredType: "article",
  coreIdea: "Checkout pages need a short cache policy so prices stay current.", takeaways: ["Set a short cache policy on checkout routes."],
  quotes: [], tags: [], appliedTo: null, lowConfidence: false,
};
const base = { id: 7, llm_api_key: "sk-test", llm_provider: "openai" as const, llm_model: "gpt-6-astra", llm_effort: "medium" as const };
const github = vi.fn();

beforeEach(() => {
  listCodeMaps.mockReset().mockResolvedValue([stale]);
  saveCodeMap.mockReset().mockResolvedValue(true);
  github.mockReset().mockImplementation(async () => new Response(JSON.stringify({ tree: [{ path: "src/checkout/cache-policy.ts", type: "blob" }] }), { status: 200 }));
  vi.stubGlobal("fetch", github);
});
afterEach(() => vi.unstubAllGlobals());

describe("matchCapture with a stale GitHub map", () => {
  // protects: AC5, the next capture matches against the refreshed file names; fails_when: the 8-day-old names are used, or the refresh isn't stored; no_claim: the model's pick
  it("reads the repo again with the user's sign-in and matches against the new names", async () => {
    const complete = vi.fn(async (_system: string, _prompt: string) => JSON.stringify({ repo: null, files: [], confidence: 0 }));
    await matchCapture({ ...base, github_token: "gho_user" }, capture, { complete, jev: null, now: () => NOW });
    expect(github).toHaveBeenCalledTimes(1);
    expect(String(github.mock.calls[0]![0])).toBe("https://api.github.com/repos/acme/shop/git/trees/HEAD?recursive=1");
    expect(saveCodeMap).toHaveBeenCalledWith(7, expect.objectContaining({ repo: "acme/shop", files: [{ p: "src/checkout/cache-policy.ts" }] }), expect.any(String), "github");
    expect(complete.mock.calls[0]![1]).toContain("src/checkout/cache-policy.ts");
  });

  // protects: AC5, a failed refresh keeps the old map and the capture still works; fails_when: a GitHub error fails matching or drops the repo; no_claim: the card's wording
  it("keeps the old names when GitHub fails", async () => {
    github.mockImplementation(async () => { throw new Error("down"); });
    const res = await matchCapture({ ...base, github_token: "gho_user" }, capture, { jev: null, now: () => NOW });
    expect(res?.noFit).toEqual({ reason: "no-shared-words" });
    expect(saveCodeMap).not.toHaveBeenCalled();
  });

  // protects: no GitHub call without a sign-in token; fails_when: matching calls GitHub for a user object without one; no_claim: none
  it("doesn't call GitHub without a token", async () => {
    await matchCapture(base, capture, { jev: null, now: () => NOW, complete: async () => "{}" });
    expect(github).not.toHaveBeenCalled();
  });
});
