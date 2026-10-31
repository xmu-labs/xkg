import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { WhereResult } from "../where";

/**
 * Both capture paths (web route and MCP tool) start matching right after
 * extraction, run it alongside writing and linking, then add the "Where it
 * applies" section to the saved file. With no maps, the file stays as today.
 * The web route answers once the file is saved and the match is in; linking
 * and the section write run after the response (next/server `after`).
 */

const capture = {
  slug: "llm-memory", inferredTitle: "LLM Memory", inferredAuthor: null, inferredUrl: null, inferredType: "article",
  coreIdea: "Memory goes into the prompt.", takeaways: ["Long prompts lose detail."], quotes: [], tags: ["llm"],
  appliedTo: null, lowConfidence: false,
};

const files = new Map<string, { content: string; sha: string }>();
const order: string[] = [];
let shaN = 0;
let failWhereWrite = false;
const githubPut = vi.fn(async (_t: string, _r: string, path: string, content: string) => {
  if (failWhereWrite && content.includes("## Where it applies")) throw new Error("GitHub 409");
  order.push(`put:${path}`);
  files.set(path, { content, sha: `sha${++shaN}` });
  return { ok: true };
});

let matchResult: WhereResult | null = null;
const matchCapture = vi.fn(async () => {
  order.push("match");
  return matchResult;
});

const afterResponse: Array<() => unknown> = [];
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (task: () => unknown) => { afterResponse.push(task); },
}));

/** Run what the route scheduled for after the response. */
async function runAfterResponse() {
  for (const task of afterResponse.splice(0)) await task();
}

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
vi.mock("@/lib/linking", () => ({
  linkCapture: vi.fn(async () => {
    order.push("link");
    return [];
  }),
}));
vi.mock("@/lib/synthesis", () => ({ synthesizeTopic: vi.fn() }));
const recordWhereEvent = vi.fn();
vi.mock("@/lib/surface-events", () => ({ recordWhereEvent: (...a: unknown[]) => recordWhereEvent(...a), recordSurfaceEvents: vi.fn() }));
vi.mock("@/lib/where", async (orig) => ({ ...(await orig<typeof import("../where")>()), matchCapture: () => matchCapture() }));
const recordHandoffEvent = vi.fn();
vi.mock("@/lib/handoff-events", () => ({ recordHandoffEvent: (...a: unknown[]) => recordHandoffEvent(...a) }));

const user = { id: 7, llm_api_key: "k", github_token: "t", github_repo: "o/r", llm_provider: "openai" };

const { POST } = await import("@/app/api/capture/route");
const { handleCapture } = await import("../mcp/handlers");
const { buildMarkdown, formatDate, detectSourceType } = await import("../llm");
const { parseHandoffs, HANDOFFS_PATH } = await import("../handoffs");

const strong: WhereResult = {
  repo: "acme/app", tier: "strong", files: [{ path: "src/llm.ts", why: "`rank` sends the whole index" }], also: [],
  map: { date: "2026-10-29", head7: "abc1234" }, scorer: "evidence", modelConf: 0.9,
};

/** POST a capture and finish the work scheduled after the response. */
async function post(): Promise<Response> {
  const res = await POST(new NextRequest("https://xkg.test/api/capture", { method: "POST", body: JSON.stringify({ content: "some notes about memory" }) }));
  await runAfterResponse();
  return res;
}

const capturePath = () => `inbox/${formatDate()}-llm-memory.md`;

beforeEach(() => {
  files.clear();
  files.set("INDEX.md", { content: "# Index\n", sha: "i" });
  order.length = 0;
  afterResponse.length = 0;
  githubPut.mockClear();
  matchCapture.mockClear();
  recordWhereEvent.mockClear();
  recordHandoffEvent.mockClear();
  failWhereWrite = false;
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
    expect(recordWhereEvent).toHaveBeenCalledWith(7, capturePath(), strong, true);
  });

  // protects: AC9, matching runs alongside writing; fails_when: matching starts after the file is written; no_claim: real latency
  it("starts matching before the file is written", async () => {
    matchResult = strong;
    await post();
    expect(order.indexOf("match")).toBeLessThan(order.indexOf(`put:${capturePath()}`));
  });

  // protects: the result shows without waiting for linking or the section write; fails_when: the route awaits either before answering; no_claim: real latency
  it("answers before linking and the section write, then runs both after the response", async () => {
    matchResult = strong;
    const res = await POST(new NextRequest("https://xkg.test/api/capture", { method: "POST", body: JSON.stringify({ content: "some notes about memory" }) }));
    expect((await res.json()).where.fit).toBe("Strong fit");
    expect(order).not.toContain("link");
    expect(files.get(capturePath())!.content).not.toContain("## Where it applies");
    await runAfterResponse();
    expect(order).toContain("link");
    expect(files.get(capturePath())!.content).toContain("## Where it applies");
  });

  // protects: linking and the section write never edit the file at the same time; fails_when: the section is written before linking ends; no_claim: none
  it("writes the section after linking", async () => {
    matchResult = strong;
    await post();
    expect(order.lastIndexOf(`put:${capturePath()}`)).toBeGreaterThan(order.indexOf("link"));
  });

  // protects: each capture leaves one log line with time per step; fails_when: a step or the model is missing, or no line is logged; no_claim: the times are accurate
  it("logs one timing line per capture", async () => {
    matchResult = strong;
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await post();
    const lines = info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("capture.timing"));
    info.mockRestore();
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]!);
    expect(line).toMatchObject({ event: "capture.timing", provider: "openai", fetched: false });
    for (const step of ["fetch", "extract", "save", "index", "match", "total", "background"]) expect(typeof line.ms[step]).toBe("number");
  });

  // protects: AC3, users with no maps keep today's file; fails_when: the file differs from buildMarkdown or is written twice; no_claim: none
  it("with no maps, keeps the file byte-identical and tells the card", async () => {
    matchResult = { repo: null, tier: "none", files: [], also: [], noFit: { reason: "no-maps" }, scorer: "evidence", modelConf: null };
    const body = await (await post()).json();
    expect(files.get(capturePath())!.content).toBe(buildMarkdown(formatDate(), capture as never, "some notes about memory", detectSourceType("some notes about memory")));
    expect(githubPut.mock.calls.filter((c) => c[2] === capturePath())).toHaveLength(1);
    expect(body.where.note).toBe("No code repos synced yet.");
  });

  // protects: a reply that can't be read changes nothing the user sees but keeps its cost; fails_when: the card or file changes, or the call goes unlogged; no_claim: none
  it("when the reply can't be read, shows nothing and logs the call as not shown", async () => {
    matchResult = { repo: null, tier: "none", files: [], also: [], noFit: { reason: "unreadable" }, scorer: "evidence", modelConf: null, tokens: { in: 3301, out: 600 } };
    const body = await (await post()).json();
    expect(body.where).toBeUndefined();
    expect(files.get(capturePath())!.content).not.toContain("## Where it applies");
    expect(recordWhereEvent).toHaveBeenCalledWith(7, capturePath(), matchResult, false);
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
    expect(recordWhereEvent).toHaveBeenCalledWith(7, capturePath(), strong, true);
  });

  // protects: card credit only for a fit the agent was shown; fails_when: a fit whose section write failed is logged as shown; no_claim: none
  it("when the section can't be written, leaves it out of the result and logs it as not shown", async () => {
    matchResult = strong;
    failWhereWrite = true;
    const result = await handleCapture(user as never, { content: "notes" });
    expect(result).not.toContain("Where it applies");
    expect(recordWhereEvent).toHaveBeenCalledWith(7, capturePath(), strong, false);
  });

  // protects: AC3 on the MCP path; fails_when: a user with no maps gets a second write or a new result line; no_claim: none
  it("with no maps, writes the file once and keeps today's result", async () => {
    matchResult = { repo: null, tier: "none", files: [], also: [], noFit: { reason: "no-maps" }, scorer: "evidence", modelConf: null };
    const result = await handleCapture(user as never, { content: "notes" });
    expect(githubPut.mock.calls.filter((c) => c[2] === capturePath())).toHaveLength(1);
    expect(result).not.toContain("Where it applies");
  });
});

describe("auto-queue for the coding agent", () => {
  const queued = () => parseHandoffs(files.get(HANDOFFS_PATH)?.content ?? "").rows;
  const possible: WhereResult = { ...strong, tier: "possible" };

  // protects: AC2 (D1), a Strong fit waits for the next session on its own; fails_when: no row, or the row lacks the files or source auto; no_claim: the match is right
  it("web: queues a Strong fit and tells the card", async () => {
    matchResult = strong;
    const body = await (await post()).json();
    expect(queued()).toEqual([{ capture: capturePath(), repo: "acme/app", kind: "code", files: ["src/llm.ts"], fit: "strong", status: "pending", since: formatDate(), source: "auto" }]);
    expect(body.handoff).toEqual({ repo: "acme/app" });
    expect(recordHandoffEvent).toHaveBeenCalledWith(7, capturePath(), "acme/app", "queued", { source: "auto" });
  });

  // protects: AC2, Possible and no-fit captures wait for the button; fails_when: either is queued; no_claim: none
  it("web: doesn't queue a Possible fit or no fit", async () => {
    for (const m of [possible, { repo: null, tier: "none", files: [], also: [], noFit: { reason: "weak" }, scorer: "evidence", modelConf: null } as WhereResult, null]) {
      matchResult = m;
      const body = await (await post()).json();
      expect(body.handoff).toBeUndefined();
    }
    expect(files.has(HANDOFFS_PATH)).toBe(false);
    expect(recordHandoffEvent).not.toHaveBeenCalled();
  });

  // protects: AC2, saving the same capture twice leaves one row; fails_when: a second row appears; no_claim: none
  it("web: saving the same capture twice leaves one row", async () => {
    matchResult = strong;
    await post();
    await post();
    expect(queued()).toHaveLength(1);
  });

  // protects: the queue write never touches GitHub while the section is being written; fails_when: HANDOFFS.md is written after the response; no_claim: none
  it("web: writes the queue before the response, the section after it", async () => {
    matchResult = strong;
    await POST(new NextRequest("https://xkg.test/api/capture", { method: "POST", body: JSON.stringify({ content: "some notes about memory" }) }));
    expect(order).toContain(`put:${HANDOFFS_PATH}`);
    await runAfterResponse();
    expect(order.indexOf(`put:${HANDOFFS_PATH}`)).toBeLessThan(order.lastIndexOf(`put:${capturePath()}`));
  });

  // protects: AC2 on the MCP path; fails_when: only the web path queues; no_claim: none
  it("MCP: queues a Strong fit and says so", async () => {
    matchResult = strong;
    const result = await handleCapture(user as never, { content: "notes" });
    expect(queued()).toEqual([expect.objectContaining({ capture: capturePath(), repo: "acme/app", source: "auto" })]);
    expect(result).toContain("Queued for your next coding session in acme/app.");
  });

  // protects: AC2 on the MCP path; fails_when: a Possible fit is queued or announced; no_claim: none
  it("MCP: doesn't queue a Possible fit", async () => {
    matchResult = possible;
    const result = await handleCapture(user as never, { content: "notes" });
    expect(files.has(HANDOFFS_PATH)).toBe(false);
    expect(result).not.toContain("Queued");
  });
});
