import { describe, it, expect, vi, afterEach } from "vitest";
import { askJev, jevPayload, jevScorer, JEV_CUTOFFS, JEV_MODEL, JEV_TIMEOUT_MS, JEV_URL } from "../jev";
import type { MapFile } from "../code-map";
import type { Candidate } from "../where-score";

/**
 * Jev (TypeSafe's decision model) decides where a capture applies: one request
 * per repo asks, for each candidate file, whether applying the capture would
 * change it. Only names leave xkg, and a failed call is an error, never a "no".
 *
 * Not covered: Jev's answers themselves (the API is stubbed here; QA runs it live).
 */

const capture = {
  title: "Smart model routing",
  coreIdea: "Route easy prompts to a cheap model and hard ones to a strong model.",
  takeaways: ["Send short prompts to a small model.", "Fall back to the large model on low confidence."],
};
const files: MapFile[] = [
  { p: "src/lib/llm.ts", e: ["callLlm", "llmSettings"], i: ["src/lib/providers.ts"] },
  { p: "src/lib/providers.ts", e: ["PROVIDERS"] },
];

const reply = (answers: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify({ model: JEV_MODEL, answers, usage: { input_tokens: 6000, output_tokens: 400 } }), { status });
const noul = (n: number) => ({ type: "noul", noul: n });
const fetchOf = (res: () => Response | Promise<Response>) =>
  vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => res());

afterEach(() => vi.useRealTimers());

describe("jevPayload", () => {
  // protects: the names-only promise toward a third party; fails_when: anything but the repo name, paths, export names, mapped import paths and the capture's extracted text is sent; no_claim: what TypeSafe does with it
  it("sends the repo name, each file's path, exports and imports, and the capture's extracted text, nothing else", () => {
    const p = jevPayload("acme/app", capture, files);
    expect(p.model).toBe(JEV_MODEL);
    expect(p.state).toEqual({
      repo: {
        name: "acme/app",
        candidate_files: {
          "src/lib/llm.ts": { exports: ["callLlm", "llmSettings"], imports: ["src/lib/providers.ts"] },
          "src/lib/providers.ts": { exports: ["PROVIDERS"], imports: [] },
        },
      },
      capture: { title: capture.title, core_idea: capture.coreIdea, takeaways: capture.takeaways },
    });
    expect(Object.keys(p.questions)).toEqual(["fit_0", "fit_1", "anything_fits"]);
    expect(p.questions.fit_1).toMatchObject({
      type: "noul",
      instructions: { file: { path: "src/lib/providers.ts", exports: ["PROVIDERS"], imports: [] } },
    });
    expect(JSON.stringify(p.questions.fit_0)).toContain("acme/app");
    expect(p.questions.anything_fits.type).toBe("noul");
  });

  // protects: spec M2d, Jev is told a file was applied before for the capture's tag; fails_when: the note is lost, or a file without one gets a history field; no_claim: how Jev weighs it
  it("sends a file's history note when it has one", () => {
    const p = jevPayload("acme/app", capture, [{ ...files[0]!, note: "applied twice before for llm" }, files[1]!]);
    expect(p.state.repo.candidate_files["src/lib/llm.ts"]).toEqual({ exports: ["callLlm", "llmSettings"], imports: ["src/lib/providers.ts"], history: "applied twice before for llm" });
    expect(p.state.repo.candidate_files["src/lib/providers.ts"]).toEqual({ exports: ["PROVIDERS"], imports: [] });
    expect(p.questions.fit_0).toMatchObject({ instructions: { file: { path: "src/lib/llm.ts", history: "applied twice before for llm" } } });
  });

  // protects: a payload's size stays bounded on a file with a huge export list; fails_when: more than 50 exports or 20 imports of one file are sent; no_claim: which names are the most useful
  it("sends at most 50 exports and 20 imports per file", () => {
    const big: MapFile = { p: "src/big.ts", e: Array.from({ length: 80 }, (_, i) => `f${i}`), i: Array.from({ length: 30 }, (_, i) => `src/m${i}.ts`) };
    const sent = jevPayload("acme/app", capture, [big]).state.repo.candidate_files["src/big.ts"]!;
    expect(sent.exports).toEqual(big.e!.slice(0, 50));
    expect(sent.imports).toEqual(big.i!.slice(0, 20));
  });
});

describe("askJev", () => {
  // protects: the key stays on the server and goes only to TypeSafe; fails_when: the key goes elsewhere, without Bearer, or the payload differs from jevPayload; no_claim: none
  it("posts the payload to TypeSafe with the key as a bearer token and returns each file's yes-score", async () => {
    const fetch = fetchOf(() => reply({ fit_0: noul(0.79), fit_1: noul(0.2), anything_fits: noul(0.7) }));
    const out = await askJev("ts-key", "acme/app", capture, files, fetch);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(JEV_URL);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: "Bearer ts-key", "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual(jevPayload("acme/app", capture, files));
    expect(out).toEqual({ fits: [0.79, 0.2], anythingFits: 0.7, tokensIn: 6000, tokensOut: 400 });
  });

  // protects: a failed call is an error, never a "no" (TypeSafe's guidance); fails_when: an HTTP error, a missing, mistyped or out-of-range answer, or a body that isn't JSON comes back as scores; no_claim: none
  it.each([
    ["an HTTP 500", () => new Response("upstream error", { status: 500 })],
    ["an HTTP 422", () => reply({}, 422)],
    ["a missing answer", () => reply({ fit_0: noul(0.5), anything_fits: noul(0.5) })],
    ["an answer of another type", () => reply({ fit_0: noul(0.5), fit_1: { type: "choice", choice: "x" }, anything_fits: noul(0.5) })],
    ["a score above 1", () => reply({ fit_0: noul(1.5), fit_1: noul(0.5), anything_fits: noul(0.5) })],
    ["a body that isn't JSON", () => new Response("<html>", { status: 200 })],
  ])("throws on %s", async (_case, res) => {
    await expect(askJev("ts-key", "acme/app", capture, files, fetchOf(res))).rejects.toThrow(/jev/i);
  });

  // protects: a slow TypeSafe never holds up a capture; fails_when: the call still waits after 5 seconds; no_claim: real network timing
  it("gives up after 5 seconds", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")))));
    const pending = askJev("ts-key", "acme/app", capture, files, fetch);
    const settled = expect(pending).rejects.toThrow(/jev/i);
    await vi.advanceTimersByTimeAsync(JEV_TIMEOUT_MS);
    await settled;
    expect(JEV_TIMEOUT_MS).toBe(5000);
  });
});

describe("jevScorer", () => {
  const cand = (repo: string, file: MapFile): Candidate => ({ repo, path: file.p, rel: 0, whyKept: false, fresh: true, file });

  // protects: one request per repo, and no file reads as a better fit than "anything fits" allows; fails_when: repos share a request, a file's p exceeds anything_fits, or tokens are not summed; no_claim: how good the cutoffs are
  it("asks once per repo, scores each file as its fit times 'anything fits', and reports the tokens", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const repo = JSON.parse(init.body as string).state.repo.name as string;
      return repo === "acme/app"
        ? reply({ fit_0: noul(0.79), fit_1: noul(0.2), anything_fits: noul(0.73) })
        : reply({ fit_0: noul(0.5), anything_fits: noul(0.1) });
    });
    const onUsage = vi.fn();
    const scorer = jevScorer("ts-key", fetch);
    const scores = await scorer.score(capture, [cand("acme/app", files[0]!), cand("acme/app", files[1]!), cand("acme/notes", { p: "src/memory.ts", e: ["recall"] })], onUsage);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(scores.map((s) => [s.repo, s.path])).toEqual([
      ["acme/app", "src/lib/llm.ts"],
      ["acme/app", "src/lib/providers.ts"],
      ["acme/notes", "src/memory.ts"],
    ]);
    expect(scores[0]!.p).toBeCloseTo(0.79 * 0.73, 10);
    expect(scores[1]!.p).toBeCloseTo(0.2 * 0.73, 10);
    expect(scores[2]!.p).toBeCloseTo(0.5 * 0.1, 10);
    expect(onUsage).toHaveBeenCalledWith({ tokensIn: 12000, tokensOut: 800 });
    expect(scorer.name).toBe("jev");
    expect(scorer.cutoffs).toEqual(JEV_CUTOFFS);
  });

  // protects: a candidate's note reaches Jev; fails_when: the scorer drops it on the way to the payload; no_claim: none
  it("passes each candidate's note to Jev", async () => {
    const fetch = fetchOf(() => reply({ fit_0: noul(0.5), anything_fits: noul(0.5) }));
    await jevScorer("ts-key", fetch).score(capture, [{ ...cand("acme/app", files[0]!), note: "applied twice before for llm" }]);
    expect(JSON.parse(fetch.mock.calls[0]![1].body as string).state.repo.candidate_files["src/lib/llm.ts"].history).toBe("applied twice before for llm");
  });

  // protects: the file Jev rates higher stays ahead even when "anything fits" is lower than both; fails_when: the gate flattens them to one score and the ranker's order picks the file; no_claim: none
  it("keeps Jev's order between files when 'anything fits' caps them", async () => {
    const fetch = fetchOf(() => reply({ fit_0: noul(0.7), fit_1: noul(0.9), anything_fits: noul(0.6) }));
    const [first, second] = await jevScorer("ts-key", fetch).score(capture, [cand("acme/app", files[0]!), cand("acme/app", files[1]!)]);
    expect(second!.p).toBeGreaterThan(first!.p);
  });

  // protects: the tiers use the cutoffs measured on captures with known targets; fails_when: they drift from the measured values; no_claim: that the values are final
  it("uses Strong 0.5 and Possible 0.4", () => {
    expect(JEV_CUTOFFS).toEqual({ strong: 0.5, possible: 0.4 });
  });

  // protects: matching-cost stats never count a call as free; fails_when: a reply without token counts adds 0 to the total; no_claim: none
  it("reports no usage when any repo's reply leaves out a token count, like the model path", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const repo = JSON.parse(init.body as string).state.repo.name as string;
      const answers = repo === "acme/app" ? { fit_0: noul(0.79), fit_1: noul(0.2), anything_fits: noul(0.73) } : { fit_0: noul(0.5), anything_fits: noul(0.1) };
      return repo === "acme/app"
        ? reply(answers)
        : new Response(JSON.stringify({ model: JEV_MODEL, answers, usage: { input_tokens: 900 } }), { status: 200 });
    });
    const onUsage = vi.fn();
    await jevScorer("ts-key", fetch).score(capture, [cand("acme/app", files[0]!), cand("acme/app", files[1]!), cand("acme/notes", { p: "src/memory.ts", e: ["recall"] })], onUsage);
    expect(onUsage).not.toHaveBeenCalled();
  });

  // protects: a candidate without its map entry can't be asked about; fails_when: Jev is asked about a file with no names; no_claim: none
  it("throws when a candidate comes without its map entry", async () => {
    await expect(jevScorer("ts-key", fetchOf(() => reply({}))).score(capture, [{ repo: "acme/app", path: "a.ts", rel: 0, whyKept: false, fresh: true }])).rejects.toThrow(/jev/i);
  });
});
