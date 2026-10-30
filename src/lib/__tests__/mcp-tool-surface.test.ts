import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Every connected agent loads the whole tool list into its context, in every
 * session. The list is cut to a few tools; the names it no longer lists keep
 * answering, because published CLIs and installed hooks still call them.
 *
 * Not covered: ranking quality (the ranker is mocked), or how a client picks a tool.
 */

const readFile = vi.fn();
const githubGet = vi.fn();
const rankByRelevance = vi.fn();

vi.mock("@/lib/db", () => ({
  getUserByApiKey: async (key: string) =>
    key === "good-key" ? { id: 7, github_token: "t", github_repo: "o/r", llm_api_key: "k" } : null,
  getUserById: async () => null,
}));
vi.mock("@/lib/oauth", () => ({ verifyToken: () => null, wwwAuthenticateHeader: () => "Bearer" }));
vi.mock("@/lib/rate-limit", () => ({ consumeQuota: vi.fn() }));
vi.mock("@/lib/llm", async (orig) => ({
  ...(await orig<typeof import("@/lib/llm")>()),
  rankByRelevance: (...a: unknown[]) => rankByRelevance(...a),
  generateApplicationSuggestions: async () => "Suggestions",
  generatePlan: async () => "# Plan",
}));
vi.mock("@/lib/github", () => ({
  githubGet: (...a: unknown[]) => githubGet(...a),
  githubPut: vi.fn(),
  githubDelete: vi.fn(),
  readFile: (...a: unknown[]) => readFile(...a),
  updateIndexEntry: vi.fn(),
}));
vi.mock("@/lib/fetch-source", () => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/linking", () => ({ linkCapture: vi.fn() }));
vi.mock("@/lib/synthesis", () => ({ synthesizeTopic: async () => ({ topic: "mcp", rules: ["Keep tools few"] }) }));
vi.mock("@/lib/apply-events", () => ({ recordApplyEvent: vi.fn() }));
const recordSurfaceEvents = vi.fn();
vi.mock("@/lib/surface-events", () => ({ recordSurfaceEvents: (...a: unknown[]) => recordSurfaceEvents(...a), recordWhereEvent: vi.fn() }));
vi.mock("@/lib/handoff-offer", () => ({ handoffOffer: async () => null }));
vi.mock("@/lib/handoff-learning", () => ({ forgetCapture: vi.fn() }));

beforeAll(() => {
  process.env.SESSION_SECRET = "test-secret-for-mcp-tool-surface";
});

const { POST } = await import("@/app/api/mcp/route");
const { TOOLS, CORE_TOOLS, LEGACY_TOOL_NAMES } = await import("@/lib/mcp/tools");
const { handleBriefing, handleSearch, handleReadCapture } = await import("@/lib/mcp/handlers");

const user = { id: 7, github_token: "t", github_repo: "o/r", llm_api_key: "k" } as never;
const INDEX = [
  "| Date | Capture | Summary | Tags | Source |",
  "|---|---|---|---|---|",
  "| 2026-10-21 | [fewer-tools](inbox/2026-10-21-fewer-tools.md) | Short tool lists... | mcp | text |",
  "| 2026-10-22 | [retries](applied/2026-10-22-retries.md) | Back off on retries... | api | text |",
  "| 2026-10-23 | [old](archived/2026-10-23-old.md) | Old idea... | mcp | text |",
].join("\n");
const CAPTURE = "---\nsource: Fewer tools\ntype: article\ntags: mcp\nstatus: inbox\n---\n# Fewer tools\n\n## Core idea\nShort lists.\n\n## Key takeaways\n- Merge read tools\n\n## Quotes\n";
const files: Record<string, string> = {
  "INDEX.md": INDEX,
  "RULES.md": "## mcp\n- Keep tools few\n",
  "inbox/2026-10-21-fewer-tools.md": CAPTURE,
  "applied/2026-10-22-retries.md": CAPTURE.replace("Fewer tools", "Retries"),
  "plans/2026-10-20-plan-x.md": "# Plan x\n",
};

function rpc(body: unknown): NextRequest {
  return new NextRequest("https://xkg.test/api/mcp", {
    method: "POST",
    headers: { authorization: "Bearer good-key", "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
}

async function call(name: string, args: Record<string, unknown>) {
  const res = await POST(rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }));
  return (await res.json()) as { error?: unknown; result?: { content: Array<{ text: string }>; isError?: boolean } };
}

beforeEach(() => {
  readFile.mockReset();
  readFile.mockImplementation(async (_t: string, _r: string, path: string) =>
    path in files ? { content: files[path], sha: "s" } : null,
  );
  githubGet.mockReset();
  githubGet.mockImplementation(async (_t: string, _r: string, dir: string) =>
    dir === "inbox" ? { ok: true, data: [{ name: "2026-10-21-fewer-tools.md" }] }
      : dir === "plans" ? { ok: true, data: [{ name: "2026-10-20-plan-x.md" }] }
      : { ok: false },
  );
  rankByRelevance.mockReset();
  rankByRelevance.mockResolvedValue([{ filename: "inbox/2026-10-21-fewer-tools.md", score: 0.82, reason: "MCP repo" }]);
});

describe("tools/list", () => {
  // protects: AC1, agents load only the 5 agent tools; fails_when: a core tool is missing or another joins; no_claim: what the listed interim extras are
  it("has exactly 5 core tools for agent work", () => {
    expect(CORE_TOOLS.map((t) => t.name)).toEqual(["capture", "briefing", "search", "read_capture", "apply_capture"]);
  });

  // protects: AC1, the token cost of the core list; fails_when: the 5 definitions grow past 4 KB; no_claim: the cost of the interim extras
  it("keeps the 5 core definitions within 4 KB", () => {
    expect(JSON.stringify(CORE_TOOLS).length).toBeLessThanOrEqual(4096);
  });

  // protects: the merged tools are gone from every agent's context; fails_when: tools/list still returns one of them; no_claim: none
  it("lists none of the merged or retired names", async () => {
    const res = await POST(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    const listed = ((await res.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    expect(listed).toEqual(TOOLS.map((t) => t.name));
    for (const name of ["search_captures", "list_inbox", "recall", "vault_scan", "apply_to_context", "get_rules", "generate_plan", "list_plans"]) {
      expect(listed).not.toContain(name);
    }
  });
});

describe("unlisted names still answer, for published CLIs and hooks", () => {
  const ARGS: Record<string, Record<string, unknown>> = {
    search_captures: {},
    list_inbox: {},
    recall: { context: "MCP tools" },
    vault_scan: { activity_context: "editing src/lib/mcp/tools.ts" },
    apply_to_context: { task: "trim tools" },
    get_rules: {},
    generate_plan: { selected_captures: ["inbox/2026-10-21-fewer-tools.md"], project_context: "xkg" },
    list_plans: {},
  };

  // protects: AC2; fails_when: the list of hidden names drifts from the ones tested here; no_claim: none
  it("covers every hidden name", () => {
    expect([...LEGACY_TOOL_NAMES].sort()).toEqual(Object.keys(ARGS).sort());
  });

  // protects: AC2, an old CLI or hook keeps working; fails_when: the name returns Unknown tool or an error; no_claim: the answer's wording
  it.each(Object.keys(ARGS))("%s returns an answer", async (name) => {
    const body = await call(name, ARGS[name]!);
    expect(body.error).toBeUndefined();
    expect(body.result!.isError).toBeUndefined();
    expect(body.result!.content[0]!.text.trim()).not.toBe("");
  });
});

describe("briefing with a task (replaces recall, vault_scan and apply_to_context)", () => {
  // protects: mid-task lookup through briefing; fails_when: task isn't ranked, or the capture's idea and score are missing; no_claim: ranking quality
  it("ranks captures against the task and returns each with its score and idea", async () => {
    const text = await handleBriefing(user, { task: "trim the MCP tools", files: ["src/lib/mcp/tools.ts"] });
    expect(rankByRelevance.mock.calls[0]![1]).toMatch(/trim the MCP tools[\s\S]*src\/lib\/mcp\/tools\.ts/);
    expect(text).toContain("### inbox/2026-10-21-fewer-tools.md (relevance: 82%)");
    expect(text).toContain("Short lists.");
    expect(text).toContain("apply_capture");
  });

  // protects: the vault hook's no-repeat rule; fails_when: an excluded capture comes back; no_claim: none
  it("leaves out captures the caller already saw", async () => {
    const text = await handleBriefing(user, { task: "trim tools", exclude: ["inbox/2026-10-21-fewer-tools.md"] });
    expect(text).not.toContain("fewer-tools");
  });

  // protects: a seen capture doesn't use up the hook's one slot; fails_when: excluded rows still reach the ranker; no_claim: ranking quality
  it("leaves excluded captures out of the index before ranking", async () => {
    await handleBriefing(user, { task: "x", exclude: ["inbox/2026-10-21-fewer-tools.md"], limit: 1 });
    const index = rankByRelevance.mock.calls[0]![2] as string;
    expect(index).not.toContain("fewer-tools");
    expect(index).toContain("retries");
  });

  // protects: surface counts only include captures shown; fails_when: a fit under min_score is returned or counted; no_claim: none
  it("drops and doesn't count fits under min_score", async () => {
    recordSurfaceEvents.mockReset();
    const text = await handleBriefing(user, { task: "x", min_score: 0.9 });
    expect(text).not.toContain("fewer-tools");
    expect(recordSurfaceEvents).not.toHaveBeenCalled();
  });

  // protects: the hook's one-result call; fails_when: limit isn't passed to the ranker; no_claim: none
  it("passes limit to the ranker, up to 10", async () => {
    await handleBriefing(user, { task: "x", limit: 1 });
    await handleBriefing(user, { task: "x", limit: 99 });
    expect(rankByRelevance.mock.calls.map((c) => c[3])).toEqual([1, 10]);
  });

  // protects: mid-task calls stay small; fails_when: rules are added without being asked for; no_claim: none
  it("leaves the rules out unless asked", async () => {
    expect(await handleBriefing(user, { task: "x" })).not.toContain("Keep tools few");
    expect(await handleBriefing(user, { task: "x", include_rules: true })).toContain("Keep tools few");
  });
});

describe("search (replaces search_captures and list_inbox)", () => {
  // protects: the inbox count the session-start hook reads; fails_when: status doesn't filter, or the header changes shape; no_claim: none
  it("filters by status and keeps the count header", async () => {
    const text = await handleSearch(user, { status: "inbox" });
    expect(text).toMatch(/^1 capture\(s\):/);
    expect(text).toContain("fewer-tools");
    expect(text).not.toContain("retries");
  });

  // protects: paging hints name a listed tool; fails_when: the footer still points at search_captures; no_claim: none
  it("names itself in the paging footer", async () => {
    const text = await handleSearch(user, { limit: 1 });
    expect(text).toContain("search");
    expect(text).not.toContain("search_captures");
  });
});

describe("hints in answers name only listed tools", () => {
  const listed = new Set(TOOLS.map((t) => t.name));
  const named = (text: string) => [...text.matchAll(/\b(list_inbox|search_captures|recall|vault_scan|apply_to_context|get_rules|generate_plan|list_plans)\b/g)].map((m) => m[1]);

  // protects: an agent isn't sent to a tool it can't see; fails_when: a not-found hint names a hidden tool; no_claim: none
  it("read_capture's not-found hint", async () => {
    const text = await handleReadCapture(user, { filename: "missing.md" });
    expect(named(text)).toEqual([]);
    expect(text).toContain("search");
    expect(listed.has("search")).toBe(true);
  });

  // protects: the briefing's "rest of the rules" pointer works through a listed tool; fails_when: RULES.md is read from inbox/; no_claim: none
  it("read_capture reads RULES.md from the repo root", async () => {
    expect(await handleReadCapture(user, { filename: "RULES.md" })).toBe(files["RULES.md"]);
  });
});
