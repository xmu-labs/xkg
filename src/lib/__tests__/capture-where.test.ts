import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { WhereResult } from "../where";

/**
 * Both capture paths (web route and MCP tool) start matching right after
 * extraction, run it alongside writing and linking, then add the "Where it
 * applies" section to the saved file. With no maps, the file stays as today.
 * Both paths answer once the file is saved and the match is in; linking and
 * the section write run after the response (next/server `after`).
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
const refundQuota = vi.fn();
const WINDOW = "2026-10-31 11:00:00.123456";
vi.mock("@/lib/rate-limit", () => ({ consumeQuota: async () => ({ allowed: true, limit: 60, resetIn: 0, windowKey: WINDOW }), refundQuota: (...a: unknown[]) => refundQuota(...a), CAPTURE_QUOTA: 60, QUOTA_WINDOW_SECONDS: 3600 }));
let fetchedPage: string | null = null;
vi.mock("@/lib/fetch-source", () => ({ fetchSourceContent: async () => fetchedPage, safeFetch: vi.fn() }));
let extractFails = false;
let indexFails = false;
vi.mock("@/lib/llm", async (orig) => ({
  ...(await orig<typeof import("../llm")>()),
  extractCapture: async (_k: string, _c: string, _t: unknown, _l: unknown, meta?: { onUsage?: (u: { tokensIn: number; tokensOut: number }) => void }) => {
    if (extractFails) throw new Error("[llm:openai] HTTP 503");
    meta?.onUsage?.({ tokensIn: 2400, tokensOut: 780 });
    return capture;
  },
}));
vi.mock("@/lib/github", () => ({
  githubPut: (...a: [string, string, string, string]) => githubPut(...a),
  githubGet: async () => ({ ok: false }),
  githubDelete: vi.fn(),
  updateIndexEntry: vi.fn(),
  appendToIndex: async () => { if (indexFails) throw new Error("GitHub 502"); order.push("index"); },
  readFile: async (_t: string, _r: string, path: string) => files.get(path) ?? null,
}));
let linked: Array<{ filename: string; reason: string }> = [];
vi.mock("@/lib/linking", () => ({
  linkCapture: vi.fn(async () => {
    order.push("link");
    return linked;
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

/** POST with the progress stream opted in; returns the response and its parsed lines (before any after-work runs). */
async function postStream(content = "some notes about memory"): Promise<{ res: Response; lines: Array<Record<string, unknown>> }> {
  const res = await POST(new NextRequest("https://xkg.test/api/capture", {
    method: "POST",
    headers: { accept: "application/x-ndjson" },
    body: JSON.stringify({ content }),
  }));
  const text = await res.text();
  const lines = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  return { res, lines };
}

/** Call the MCP tool and finish the work scheduled after its answer. */
async function mcp(): Promise<string> {
  const result = await handleCapture(user as never, { content: "notes" });
  await runAfterResponse();
  return result;
}

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
  extractFails = false;
  refundQuota.mockClear();
  linked = [];
  fetchedPage = null;
  indexFails = false;
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

  // protects: the card can show what the capture cost; fails_when: the result lacks the model or the token counts; no_claim: the provider's counts are right
  it("returns the model and the token counts with the result", async () => {
    const body = await (await post()).json();
    expect(body.usage).toEqual({ model: "gpt-4o-mini", tokensIn: 2400, tokensOut: 780 });
  });

  // protects: a failed extraction costs no quota; fails_when: the hourly count keeps the failed try; no_claim: none
  it("gives the quota back when extraction fails", async () => {
    extractFails = true;
    const res = await post();
    expect(res.status).toBe(502);
    expect(refundQuota).toHaveBeenCalledWith("capture:user:7", WINDOW);
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
    expect(line).toMatchObject({ event: "capture.timing", via: "web", provider: "openai", fetched: false });
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

describe("web capture progress stream", () => {
  // protects: the page can show each stage; fails_when: stages are missing, out of order, or the result isn't last; no_claim: timing
  it("streams reading, extracting and saving, then the result, for a URL", async () => {
    fetchedPage = "The page text about memory.";
    matchResult = strong;
    const { res, lines } = await postStream("https://example.com/post");
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    expect(lines.slice(0, 3)).toEqual([{ stage: "reading" }, { stage: "extracting" }, { stage: "saving" }]);
    const last = lines.at(-1)!;
    expect((last.result as { filename: string }).filename).toBe(`${formatDate()}-llm-memory.md`);
    expect((last.result as { where: { fit: string } }).where.fit).toBe("Strong fit");
    expect(lines).toHaveLength(4);
  });

  // protects: notes skip the page-reading stage; fails_when: "reading" shows for pasted text; no_claim: none
  it("skips the reading stage for pasted text", async () => {
    const { lines } = await postStream();
    expect(lines.map((l) => l.stage ?? "result")).toEqual(["extracting", "saving", "result"]);
  });

  // protects: links and the section are written only after the stream ends; fails_when: linking runs before the result line; no_claim: none
  it("links and writes the section after the stream, not during it", async () => {
    matchResult = strong;
    await postStream();
    expect(order).not.toContain("link");
    await runAfterResponse();
    expect(order).toContain("link");
    expect(files.get(capturePath())!.content).toContain("## Where it applies");
  });

  // protects: an extraction failure reaches the page as an error line and costs no quota; fails_when: the stream ends silently or the quota is kept; no_claim: none
  it("ends with an error line when extraction fails, and gives the quota back", async () => {
    extractFails = true;
    const { lines } = await postStream();
    expect(lines.map((l) => l.stage ?? "end")).toEqual(["extracting", "end"]);
    expect(lines.at(-1)).toEqual({ error: "[llm:openai] HTTP 503", status: 502 });
    expect(refundQuota).toHaveBeenCalledWith("capture:user:7", WINDOW);
  });

  // protects: an unexpected failure mid-stream ends the stream with an error and never hangs the after-work; fails_when: the stream throws or the after task waits forever; no_claim: none
  it("ends with an error line when saving fails, and the after-work still finishes", async () => {
    indexFails = true;
    const { lines } = await postStream();
    expect(lines.at(-1)).toEqual({ error: "[capture] GitHub 502", status: 500 });
    await runAfterResponse();
    expect(order).not.toContain("link");
  });

  // protects: errors before any work keep their HTTP status; fails_when: a 400 arrives as a 200 stream; no_claim: none
  it("answers plain JSON with a status for a request it rejects up front", async () => {
    const { res, lines } = await postStream("   ");
    expect(res.status).toBe(400);
    expect(lines).toEqual([{ error: "content is required" }]);
  });

  // protects: clients that don't opt in get today's single JSON answer; fails_when: the stream is sent without the Accept header; no_claim: none
  it("keeps the single JSON answer without the opt-in", async () => {
    const res = await post();
    expect(res.headers.get("content-type")).toContain("application/json");
    expect((await res.json()).filename).toBe(`${formatDate()}-llm-memory.md`);
  });
});

describe("MCP capture", () => {
  // protects: the MCP path writes the section too and tells the agent; fails_when: only the web path gets it; no_claim: none
  it("writes the section and adds one line to the tool result", async () => {
    matchResult = strong;
    const result = await mcp();
    expect(files.get(capturePath())!.content).toContain("## Where it applies\n**Strong fit** · acme/app");
    expect(result).toContain("Where it applies: Strong fit in acme/app: src/llm.ts");
    expect(recordWhereEvent).toHaveBeenCalledWith(7, capturePath(), strong, true);
  });

  // protects: the agent gets its answer without waiting for linking or the section write; fails_when: the tool awaits either before answering; no_claim: real latency
  it("answers before linking and the section write, then runs both after the answer", async () => {
    matchResult = strong;
    const result = await handleCapture(user as never, { content: "notes" });
    expect(result).toContain("Where it applies: Strong fit");
    expect(order).not.toContain("link");
    expect(files.get(capturePath())!.content).not.toContain("## Where it applies");
    await runAfterResponse();
    expect(order).toContain("link");
    expect(order.lastIndexOf(`put:${capturePath()}`)).toBeGreaterThan(order.indexOf("link"));
  });

  // protects: the result doesn't promise a link count it can't know yet; fails_when: "Linked to" stays in the text; no_claim: none
  it("doesn't report a link count", async () => {
    linked = [{ filename: "inbox/a.md", reason: "shared: llm, memory" }, { filename: "inbox/b.md", reason: "shared: llm, prompt" }];
    expect(await mcp()).not.toContain("Linked to");
  });

  // protects: a section write that fails after the answer changes nothing already said; fails_when: the write failure throws out of the background task; no_claim: none
  it("when the section can't be written after the answer, the file stays without it", async () => {
    matchResult = strong;
    failWhereWrite = true;
    const result = await mcp();
    expect(result).toContain("Where it applies: Strong fit");
    expect(files.get(capturePath())!.content).not.toContain("## Where it applies");
  });

  // protects: AC3 on the MCP path; fails_when: a user with no maps gets a second write or a new result line; no_claim: none
  it("with no maps, writes the file once and keeps today's result", async () => {
    matchResult = { repo: null, tier: "none", files: [], also: [], noFit: { reason: "no-maps" }, scorer: "evidence", modelConf: null };
    const result = await mcp();
    expect(githubPut.mock.calls.filter((c) => c[2] === capturePath())).toHaveLength(1);
    expect(result).not.toContain("Where it applies");
  });

  // protects: the MCP index row gets the same retry as the web path; fails_when: the tool writes INDEX.md itself without appendToIndex; no_claim: none
  it("adds the index row through appendToIndex", async () => {
    await mcp();
    expect(order).toContain("index");
    expect(order).not.toContain("put:INDEX.md");
  });

  // protects: a failed MCP extraction costs no quota; fails_when: the hourly count keeps the failed try; no_claim: none
  it("gives the quota back when extraction fails, and still reports the error", async () => {
    extractFails = true;
    await expect(handleCapture(user as never, { content: "notes" })).rejects.toThrow("HTTP 503");
    expect(refundQuota).toHaveBeenCalledWith("capture:user:7", WINDOW);
  });

  // protects: MCP captures are timed like web ones; fails_when: no line, or the path isn't named; no_claim: the times are accurate
  it("logs one timing line marked mcp", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await mcp();
    const lines = info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("capture.timing"));
    info.mockRestore();
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]!);
    expect(line).toMatchObject({ event: "capture.timing", via: "mcp", provider: "openai" });
    for (const step of ["extract", "save", "index", "match", "total", "background"]) expect(typeof line.ms[step]).toBe("number");
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
    const result = await mcp();
    expect(queued()).toEqual([expect.objectContaining({ capture: capturePath(), repo: "acme/app", source: "auto" })]);
    expect(result).toContain("Queued for your next coding session in acme/app.");
  });

  // protects: AC2 on the MCP path; fails_when: a Possible fit is queued or announced; no_claim: none
  it("MCP: doesn't queue a Possible fit", async () => {
    matchResult = possible;
    const result = await mcp();
    expect(files.has(HANDOFFS_PATH)).toBe(false);
    expect(result).not.toContain("Queued");
  });
});
