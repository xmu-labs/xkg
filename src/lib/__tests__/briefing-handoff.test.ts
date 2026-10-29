import { describe, it, expect, vi, beforeEach } from "vitest";
import type { User } from "../db";

/**
 * briefing with `repo`: captures waiting in HANDOFFS.md for that repo come
 * first, as the session-start offer. With nothing waiting, or no repo, the
 * output is exactly today's. With only a repo, the offer is all it returns
 * and no LLM call is made, so a session-start hook stays fast.
 *
 * Not covered: ranking quality (mocked), what the counts store (handoff-events test).
 */

const files: Record<string, string> = {};
const puts: Array<{ path: string; content: string }> = [];
const rankByRelevance = vi.fn();
const recordSurfaceEvents = vi.fn();
const offerDays = vi.fn();
const recordOffers = vi.fn();
const recordHandoffEvent = vi.fn();
const codeMapPaths = vi.fn();

vi.mock("../rate-limit", () => ({ consumeQuota: vi.fn() }));
vi.mock("../llm", async (orig) => ({
  ...(await orig<typeof import("../llm")>()),
  formatDate: () => "2026-10-29",
  rankByRelevance: (...a: unknown[]) => rankByRelevance(...a),
}));
vi.mock("../github", () => ({
  githubGet: vi.fn(),
  githubPut: async (_t: string, _r: string, path: string, content: string) => {
    puts.push({ path, content });
    files[path] = content;
  },
  githubDelete: vi.fn(),
  readFile: async (_t: string, _r: string, path: string) => (path in files ? { content: files[path], sha: "s" } : null),
  updateIndexEntry: vi.fn(),
}));
vi.mock("../db", async (orig) => ({ ...(await orig<typeof import("../db")>()), codeMapPaths: (...a: unknown[]) => codeMapPaths(...a) }));
vi.mock("../surface-events", () => ({ recordSurfaceEvents: (...a: unknown[]) => recordSurfaceEvents(...a), recordWhereEvent: vi.fn() }));
vi.mock("../handoff-events", () => ({
  offerDays: (...a: unknown[]) => offerDays(...a),
  recordOffers: (...a: unknown[]) => recordOffers(...a),
  recordHandoffEvent: (...a: unknown[]) => recordHandoffEvent(...a),
}));
vi.mock("../linking", () => ({ linkCapture: vi.fn() }));
vi.mock("../synthesis", () => ({ synthesizeTopic: vi.fn() }));
vi.mock("../apply-events", async (orig) => ({ ...(await orig<typeof import("../apply-events")>()), recordApplyEvent: vi.fn() }));

const { handleBriefing } = await import("../mcp/handlers");
const { renderHandoffs, parseHandoffs } = await import("../handoffs");
type Row = import("../handoffs").HandoffRow;

const user = { id: 1, github_token: "t", github_repo: "o/r", llm_api_key: "k" } as unknown as User;
const CAPTURE = (title: string) => `---\ndate: 2026-10-20\n---\n\n# ${title}\n\n## Core idea\nIdea.\n\n## Key takeaways\n- a\n`;
const row = (name: string, over: Partial<Row> = {}): Row => ({
  capture: `inbox/${name}.md`, repo: "acme/app", kind: "code", files: ["src/llm.ts"], fit: "strong", status: "pending", since: "2026-10-28", source: "auto", ...over,
});

function setup(rows: Row[]) {
  for (const k of Object.keys(files)) delete files[k];
  files["INDEX.md"] = "| 2026-10-21 | Fewer tools | inbox/2026-10-21-fewer-tools.md | x | mcp |";
  files["inbox/2026-10-21-fewer-tools.md"] = CAPTURE("Fewer tools");
  files["RULES.md"] = "## mcp\n- Keep tools few\n";
  for (const r of rows) files[r.capture] = CAPTURE(`Title of ${r.capture.slice(6, -3)}`);
  if (rows.length) files["HANDOFFS.md"] = renderHandoffs(rows);
}

beforeEach(() => {
  puts.length = 0;
  rankByRelevance.mockReset().mockResolvedValue([{ filename: "inbox/2026-10-21-fewer-tools.md", score: 0.8, reason: "MCP repo" }]);
  recordSurfaceEvents.mockReset();
  offerDays.mockReset().mockResolvedValue(new Map());
  recordOffers.mockReset();
  recordHandoffEvent.mockReset();
  codeMapPaths.mockReset().mockResolvedValue(new Set(["src/llm.ts", "src/briefing.ts"]));
});

describe("briefing with a repo", () => {
  // protects: AC5 (D8), the dogfood's briefing text doesn't change when nothing waits; fails_when: any byte differs with a repo and no rows; no_claim: ranking
  it("returns exactly today's text when nothing waits for the repo", async () => {
    setup([row("2026-10-28-other", { repo: "acme/web" })]);
    const plain = await handleBriefing(user, { project_context: "repo: app" });
    const withRepo = await handleBriefing(user, { project_context: "repo: app", repo: "acme/app" });
    expect(withRepo).toBe(plain);
    setup([]);
    expect(await handleBriefing(user, { project_context: "repo: app", repo: "acme/app" })).toBe(plain);
    expect(recordOffers).not.toHaveBeenCalled();
  });

  // protects: the session-start path stays fast and costs the user nothing; fails_when: a repo-only call ranks with the LLM or adds candidates; no_claim: network latency
  it("with only a repo, returns the offer and makes no LLM call", async () => {
    setup([row("2026-10-28-llm-memory")]);
    const text = await handleBriefing(user, { repo: "acme/app" });
    expect(text.split("\n")[0]).toBe("xkg: 1 capture fits this repo (acme/app). Want to see it and apply it?");
    expect(text).toContain("1. Title of 2026-10-28-llm-memory · Strong fit · inbox/2026-10-28-llm-memory.md");
    expect(text).not.toContain("xkg briefing:");
    expect(rankByRelevance).not.toHaveBeenCalled();
  });

  // protects: pull and push give the same offer; fails_when: the offer differs between a repo-only call and a full briefing; no_claim: none
  it("puts the same offer before the usual candidates", async () => {
    setup([row("2026-10-28-llm-memory")]);
    const offer = await handleBriefing(user, { repo: "acme/app" });
    setup([]);
    const plain = await handleBriefing(user, { project_context: "repo: app" });
    setup([row("2026-10-28-llm-memory")]);
    expect(await handleBriefing(user, { project_context: "repo: app", repo: "acme/app" })).toBe(`${offer}\n\n${plain}`);
  });

  // protects: AC6, the total, 3 listed, and every offer counted; fails_when: more than 3 are listed, or the shown ones go uncounted; no_claim: what is stored
  it("lists 3 of 4 and counts each one shown", async () => {
    setup([row("a", { since: "2026-10-25" }), row("b", { since: "2026-10-24" }), row("c", { fit: "possible", since: "2026-10-01" }), row("d", { since: "2026-10-26" })]);
    const text = await handleBriefing(user, { repo: "acme/app" });
    expect(text.split("\n")[0]).toBe("xkg: 4 captures fit this repo (acme/app). Want to see them and apply one?");
    const list = text.slice(text.indexOf("## Waiting for you"), text.indexOf("If the user says yes"));
    expect(list.match(/^\d\. /gm)).toEqual(["1. ", "2. ", "3. "]);
    expect(text).not.toContain("inbox/c.md");
    expect(recordOffers).toHaveBeenCalledWith(1, "acme/app", ["inbox/b.md", "inbox/a.md", "inbox/d.md"]);
    expect(recordSurfaceEvents).toHaveBeenCalledWith(1, ["inbox/b.md", "inbox/a.md", "inbox/d.md"], "handoff");
  });

  // protects: AC8, a row offered on 3 days with no answer expires and isn't offered again; fails_when: it is shown, or HANDOFFS.md keeps it pending; no_claim: day counting (offer test)
  it("expires a row offered on 3 earlier days", async () => {
    setup([row("old", { since: "2026-10-20" }), row("new")]);
    offerDays.mockResolvedValue(new Map([["old.md", ["2026-10-21", "2026-10-22", "2026-10-23"]]]));
    const text = await handleBriefing(user, { repo: "acme/app" });
    expect(text).not.toContain("inbox/old.md");
    expect(text.split("\n")[0]).toContain("1 capture fits");
    expect(parseHandoffs(files["HANDOFFS.md"]!).rows.find((r) => r.capture === "inbox/old.md")!.status).toBe("expired");
    expect(recordHandoffEvent).toHaveBeenCalledWith(1, "inbox/old.md", "acme/app", "expired");
  });

  // protects: AC7, a suggested file gone from the current map is labeled; fails_when: it reads as an existing file; no_claim: none
  it("labels files that left the map since the capture", async () => {
    setup([row("2026-10-28-llm-memory", { files: ["src/llm.ts", "src/gone.ts"] })]);
    const text = await handleBriefing(user, { repo: "acme/app" });
    expect(text).toContain("Files: src/llm.ts (from file names, not yet checked in your code). src/gone.ts moved or deleted since the capture");
  });

  // protects: a capture moved to applied/ is still offered, a deleted one is not; fails_when: a missing capture is offered or a moved one dropped; no_claim: none
  it("finds a capture in applied/ and skips one that's gone", async () => {
    setup([row("moved"), row("gone")]);
    files["applied/moved.md"] = files["inbox/moved.md"]!;
    delete files["inbox/moved.md"];
    delete files["inbox/gone.md"];
    const text = await handleBriefing(user, { repo: "acme/app" });
    expect(text.split("\n")[0]).toContain("1 capture fits");
    expect(text).toContain("Title of moved");
    expect(text).not.toContain("inbox/gone.md");
  });

  // protects: a repo-only call with nothing waiting says so plainly and stays cheap; fails_when: it ranks or returns a briefing; no_claim: none
  it("with only a repo and nothing waiting, says so", async () => {
    setup([]);
    expect(await handleBriefing(user, { repo: "Acme/App" })).toBe("No captures are waiting for acme/app.");
    expect(rankByRelevance).not.toHaveBeenCalled();
  });
});
