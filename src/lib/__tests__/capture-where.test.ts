import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { WhereResult } from "../where";

/**
 * Both capture paths (web route and MCP tool) start matching right after
 * extraction, run it alongside writing and linking, then add the "Where it
 * applies" section to the saved file. With no maps, the file stays as today.
 */

const capture = {
  slug: "llm-memory", inferredTitle: "LLM Memory", inferredAuthor: null, inferredUrl: null, inferredType: "article",
  coreIdea: "Memory goes into the prompt.", takeaways: ["Long prompts lose detail."], quotes: [], tags: ["llm"],
  appliedTo: null, lowConfidence: false,
};

const files = new Map<string, { content: string; sha: string }>();
const order: string[] = [];
let shaN = 0;
const githubPut = vi.fn(async (_t: string, _r: string, path: string, content: string) => {
  order.push(`put:${path}`);
  files.set(path, { content, sha: `sha${++shaN}` });
  return { ok: true };
});

let matchResult: WhereResult | null = null;
let releaseMatch: (() => void) | null = null;
const matchCapture = vi.fn(() => {
  order.push("match");
  return new Promise<WhereResult | null>((resolve) => {
    releaseMatch = () => resolve(matchResult);
  });
});

vi.mock("@/lib/session", () => ({ getSession: async () => user }));
vi.mock("@/lib/rate-limit", () => ({ consumeQuota: async () => ({ allowed: true, limit: 60, resetIn: 0 }), CAPTURE_QUOTA: 60, QUOTA_WINDOW_SECONDS: 3600 }));
vi.mock("@/lib/fetch-source", () => ({ fetchSourceContent: async () => null, safeFetch: vi.fn() }));
vi.mock("@/lib/llm", async (orig) => ({ ...(await orig<typeof import("../llm")>()), extractCapture: async () => capture }));
vi.mock("@/lib/github", () => ({
  githubPut: (...a: [string, string, string, string]) => githubPut(...a),
  githubGet: async () => ({ ok: false }),
  githubDelete: vi.fn(),
  updateIndexEntry: vi.fn(),
  appendToIndex: async () => { order.push("index"); },
  readFile: async (_t: string, _r: string, path: string) => files.get(path) ?? null,
}));
// Linking finishes only after matching has started; matching resolves only once
// linking has run. A route that awaited one before starting the other would hang.
vi.mock("@/lib/linking", () => ({
  linkCapture: vi.fn(async () => {
    order.push("link");
    releaseMatch?.();
    return [];
  }),
}));
vi.mock("@/lib/synthesis", () => ({ synthesizeTopic: vi.fn() }));
const recordWhereEvent = vi.fn();
vi.mock("@/lib/surface-events", () => ({ recordWhereEvent: (...a: unknown[]) => recordWhereEvent(...a), recordSurfaceEvents: vi.fn() }));
vi.mock("@/lib/where", async (orig) => ({ ...(await orig<typeof import("../where")>()), matchCapture: () => matchCapture() }));

const user = { id: 7, llm_api_key: "k", github_token: "t", github_repo: "o/r", llm_provider: "openai" };

const { POST } = await import("@/app/api/capture/route");
const { handleCapture } = await import("../mcp/handlers");
const { buildMarkdown, formatDate, detectSourceType } = await import("../llm");

const strong: WhereResult = {
  repo: "acme/app", tier: "strong", files: [{ path: "src/llm.ts", why: "`rank` sends the whole index" }], also: [],
  map: { date: "2026-10-29", head7: "abc1234" }, scorer: "evidence", modelConf: 0.9,
};

function post(): Promise<Response> {
  return POST(new NextRequest("https://xkg.test/api/capture", { method: "POST", body: JSON.stringify({ content: "some notes about memory" }) }));
}

const capturePath = () => `inbox/${formatDate()}-llm-memory.md`;

beforeEach(() => {
  files.clear();
  files.set("INDEX.md", { content: "# Index\n", sha: "i" });
  order.length = 0;
  githubPut.mockClear();
  matchCapture.mockClear();
  recordWhereEvent.mockClear();
});

describe("web capture", () => {
  // protects: the section reaches the file and the card; fails_when: the file lacks it after Core idea, or the response has no where; no_claim: the match is right
  it("writes the section after Core idea and returns the card", async () => {
    matchResult = strong;
    const body = await (await post()).json();
    const saved = files.get(capturePath())!.content;
    expect(saved).toContain(`## Core idea\n${capture.coreIdea}\n\n## Where it applies\n**Strong fit** · acme/app`);
    expect(body.where).toEqual({ fit: "Strong fit", repo: "acme/app", files: strong.files, also: [], note: expect.stringContaining("not yet checked") });
  });

  // protects: D6 and AC21, the card's match is logged with its cost; fails_when: the web path shows a match without logging it; no_claim: what is stored
  it("logs the match against the saved file", async () => {
    matchResult = strong;
    await post();
    expect(recordWhereEvent).toHaveBeenCalledWith(7, capturePath(), strong);
  });

  // protects: AC9, matching runs alongside writing and linking; fails_when: matching starts after the file is written or blocks linking; no_claim: real latency
  it("starts matching before the file is written and lets linking run meanwhile", async () => {
    matchResult = strong;
    await post();
    expect(order.indexOf("match")).toBeLessThan(order.indexOf(`put:${capturePath()}`));
    expect(order.indexOf("link")).toBeGreaterThan(order.indexOf("match"));
    expect(order.at(-1)).toBe(`put:${capturePath()}`);
  });

  // protects: AC3, users with no maps keep today's file; fails_when: the file differs from buildMarkdown or is written twice; no_claim: none
  it("with no maps, keeps the file byte-identical and tells the card", async () => {
    matchResult = { repo: null, tier: "none", files: [], also: [], noFit: { reason: "no-maps" }, scorer: "evidence", modelConf: null };
    const body = await (await post()).json();
    expect(files.get(capturePath())!.content).toBe(buildMarkdown(formatDate(), capture as never, "some notes about memory", detectSourceType("some notes about memory")));
    expect(githubPut.mock.calls.filter((c) => c[2] === capturePath())).toHaveLength(1);
    expect(body.where.note).toBe("No code repos synced yet.");
  });

  // protects: a failed match changes nothing; fails_when: the response or file changes when matching returns null; no_claim: none
  it("when matching fails, saves the capture as before with no where", async () => {
    matchResult = null;
    const body = await (await post()).json();
    expect(body.where).toBeUndefined();
    expect(files.get(capturePath())!.content).not.toContain("## Where it applies");
  });
});

describe("MCP capture", () => {
  // protects: the MCP path writes the section too and tells the agent; fails_when: only the web path gets it; no_claim: none
  it("writes the section and adds one line to the tool result", async () => {
    matchResult = strong;
    const result = await handleCapture(user as never, { content: "notes" });
    expect(files.get(capturePath())!.content).toContain("## Where it applies\n**Strong fit** · acme/app");
    expect(result).toContain("Where it applies: Strong fit in acme/app: src/llm.ts");
    expect(recordWhereEvent).toHaveBeenCalledWith(7, capturePath(), strong);
  });

  // protects: AC3 on the MCP path; fails_when: a user with no maps gets a second write or a new result line; no_claim: none
  it("with no maps, writes the file once and keeps today's result", async () => {
    matchResult = { repo: null, tier: "none", files: [], also: [], noFit: { reason: "no-maps" }, scorer: "evidence", modelConf: null };
    const result = await handleCapture(user as never, { content: "notes" });
    expect(githubPut.mock.calls.filter((c) => c[2] === capturePath())).toHaveLength(1);
    expect(result).not.toContain("Where it applies");
  });
});
