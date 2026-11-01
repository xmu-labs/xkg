import { describe, it, expect, vi, beforeEach } from "vitest";
import type { User } from "../db";

/**
 * The briefing tool ranks captures with one LLM call and returns them as
 * candidates for the agent to check against the code. A second LLM call used
 * to write the briefing, and it named code files it had never seen.
 *
 * Not covered: ranking quality (the ranker is mocked).
 */

const readFile = vi.fn();
const githubGet = vi.fn();
const rankByRelevance = vi.fn();
// Same files as readFile; a test swaps in a failed read.
const readFileStrict = vi.fn();

vi.mock("../rate-limit", () => ({ consumeQuota: vi.fn() }));
// Only the ranker is an LLM call here. Any other LLM export the handler
// reached for would be missing from this mock and fail the import.
vi.mock("../llm", () => ({
  extractCapture: vi.fn(),
  detectSourceType: () => "text",
  formatDate: () => "2026-01-01",
  buildIndexRow: () => "row",
  rankByRelevance: (...a: unknown[]) => rankByRelevance(...a),
  generateApplicationSuggestions: vi.fn(),
  generatePlan: vi.fn(),
  curateSingle: vi.fn(),
  filterByDateRange: (f: unknown[]) => f,
  paginate: (i: unknown[]) => ({ items: i, total: i.length, offset: 0, limit: 10, hasMore: false }),
  pageFooter: () => "",
  matchIndexRows: (r: unknown[]) => r,
  llmSettings: () => ({}),
}));
vi.mock("../github", () => ({
  githubGet: (...a: unknown[]) => githubGet(...a),
  githubPut: vi.fn(),
  githubDelete: vi.fn(),
  readFile: (...a: unknown[]) => readFile(...a),
  readFileStrict: (...a: unknown[]) => readFileStrict(...a),
  GitHubReadError: class extends Error {},
  updateIndexEntry: vi.fn(),
}));
vi.mock("../fetch-source", () => ({ safeFetch: vi.fn() }));
vi.mock("../linking", () => ({ linkCapture: vi.fn() }));
vi.mock("../synthesis", () => ({ synthesizeTopic: vi.fn() }));
vi.mock("../apply-events", () => ({ recordApplyEvent: vi.fn() }));
const recordSurfaceEvents = vi.fn();
vi.mock("../surface-events", () => ({ recordSurfaceEvents: (...a: unknown[]) => recordSurfaceEvents(...a), recordWhereEvent: vi.fn() }));

const { handleBriefing } = await import("../mcp/handlers");
const { briefingCandidate, formatBriefing } = await import("../briefing");

const user = { id: 1, github_token: "t", github_repo: "o/r", llm_api_key: "k" } as unknown as User;
const INDEX = "| 2026-10-21 | Fewer tools | inbox/2026-10-21-fewer-tools.md | Short tool lists | mcp |";
const CAPTURE = "# Fewer tools\n\n## Core idea\nShort lists.\n\n## Key takeaways\n- Merge read tools\n\n## Quotes\n";
const RULES = "## mcp\n- Keep tools few\n";

const files: Record<string, string> = {
  "INDEX.md": INDEX,
  "inbox/2026-10-21-fewer-tools.md": CAPTURE,
  "RULES.md": RULES,
};

beforeEach(() => {
  readFile.mockReset();
  readFile.mockImplementation(async (_t: string, _r: string, path: string) =>
    path in files ? { content: files[path], sha: "s" } : null,
  );
  readFileStrict.mockReset();
  readFileStrict.mockImplementation(async (_t: string, _r: string, path: string) =>
    path in files ? { content: files[path], sha: "s" } : null,
  );
  githubGet.mockReset();
  recordSurfaceEvents.mockReset();
  rankByRelevance.mockReset();
  rankByRelevance.mockResolvedValue([{ filename: "inbox/2026-10-21-fewer-tools.md", score: 0.8, reason: "MCP repo" }]);
});

describe("handleBriefing", () => {
  it("ranks once and returns the captures as candidates for the agent", async () => {
    const text = await handleBriefing(user, { project_context: "repo: xkg" });

    expect(rankByRelevance).toHaveBeenCalledTimes(1);
    expect(rankByRelevance.mock.calls[0]![3]).toBe(5);
    expect(text).toBe(
      formatBriefing([briefingCandidate("inbox/2026-10-21-fewer-tools.md", 0.8, "MCP repo", CAPTURE)], RULES),
    );
  });

  it("leaves the rules out when asked to", async () => {
    const text = await handleBriefing(user, { project_context: "repo: xkg", include_rules: false });
    expect(text).not.toContain("## Rules");
    expect(readFile).not.toHaveBeenCalledWith("t", "o/r", "RULES.md");
  });

  it("skips a ranked capture that can no longer be read", async () => {
    rankByRelevance.mockResolvedValue([
      { filename: "inbox/2026-10-21-fewer-tools.md", score: 0.8, reason: "MCP repo" },
      { filename: "inbox/gone.md", score: 0.9, reason: "x" },
    ]);
    files["INDEX.md"] = `${INDEX}\n| 2026-10-22 | Gone | inbox/gone.md | x | x |`;
    const text = await handleBriefing(user, { project_context: "repo: xkg" });
    expect(text).toMatch(/^xkg briefing: 1 capture may fit this work\./);
    files["INDEX.md"] = INDEX;
  });
});

describe("handleBriefing with no repo, task or project (a chat app)", () => {
  const CHAT_INDEX = [
    "| Date | Capture | Summary | Tags | Type |",
    "|---|---|---|---|---|",
    "| 2026-10-21 | [fewer-tools](inbox/2026-10-21-fewer-tools.md) | Short tool lists... | mcp | article |",
    "| 2026-10-29 | [ship-small](inbox/2026-10-29-ship-small.md) | Ship in small slices... | process | note |",
    "| 2026-10-25 | [old-win](applied/2026-10-25-old-win.md) | Already used... | x | note |",
  ].join("\n");

  it("says how many captures are in the inbox and lists the newest, with no LLM call", async () => {
    files["INDEX.md"] = CHAT_INDEX;
    const text = await handleBriefing(user, {});
    files["INDEX.md"] = INDEX;

    expect(rankByRelevance).not.toHaveBeenCalled();
    expect(text).toBe(
      [
        "xkg inbox: 2 captures waiting. Newest first:",
        "- 2026-10-29-ship-small.md: Ship in small slices",
        "- 2026-10-21-fewer-tools.md: Short tool lists",
        "",
        "Tell the user how many captures are waiting. To open one, call read_capture with its name. To find the captures that fit what the user asks about, call briefing with task set to it.",
      ].join("\n"),
    );
  });

  it("lists at most five", async () => {
    const rows = Array.from({ length: 7 }, (_, i) => `| 2026-10-1${i} | [c${i}](inbox/2026-10-1${i}-c${i}.md) | S${i}... | t | note |`);
    files["INDEX.md"] = rows.join("\n");
    const text = await handleBriefing(user, {});
    files["INDEX.md"] = INDEX;

    expect(text).toMatch(/^xkg inbox: 7 captures waiting\. Newest first:/);
    expect(text.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(5);
    expect(text).toContain("- 2026-10-16-c6.md: S6");
    expect(text).not.toContain("-c1.md");
  });

  it("says the inbox is empty when nothing is waiting", async () => {
    files["INDEX.md"] = "| 2026-10-25 | [old-win](applied/2026-10-25-old-win.md) | Already used... | x | note |";
    const text = await handleBriefing(user, {});
    files["INDEX.md"] = INDEX;

    expect(text).toBe("xkg inbox: empty. When the user shares something worth keeping, call capture.");
  });

  it("points to capture when there is no INDEX yet", async () => {
    const saved = files["INDEX.md"];
    delete files["INDEX.md"];
    const text = await handleBriefing(user, {});
    files["INDEX.md"] = saved!;

    expect(text).toBe("xkg inbox: empty. When the user shares something worth keeping, call capture.");
  });

  // Regression: ISSUE-001 — the list showed the INDEX slug, which read_capture can't open
  // Found by /qa on 2026-11-01
  // Report: /mnt/project-files/qa/2026-11-01-xkg-124-chat-briefing/qa-report-mcp-briefing-2026-11-01.md
  it("names each capture by the filename read_capture opens", async () => {
    files["INDEX.md"] = CHAT_INDEX;
    const text = await handleBriefing(user, {});
    files["INDEX.md"] = INDEX;
    expect(text).toContain("- 2026-10-29-ship-small.md:");
    expect(text).not.toContain("- ship-small ");
  });

  // Regression: ISSUE-002 — a failed GitHub read was shown as an empty inbox
  // Found by /qa on 2026-11-01
  // Report: /mnt/project-files/qa/2026-11-01-xkg-124-chat-briefing/qa-report-mcp-briefing-2026-11-01.md
  it("lets a failed GitHub read surface as an error, not an empty inbox", async () => {
    readFileStrict.mockRejectedValueOnce(new Error("GitHub read of INDEX.md failed (HTTP 403)"));
    await expect(handleBriefing(user, {})).rejects.toThrow("HTTP 403");
  });

  // protects: a capture saved today shows before an earlier one from the same day; fails_when: same-date rows keep INDEX (oldest-first) order; no_claim: INDEX order on other writers
  it("puts the later row first among captures from the same day", async () => {
    files["INDEX.md"] = [
      "| 2026-10-29 | [first](inbox/2026-10-29-first.md) | Saved first... | t | note |",
      "| 2026-10-29 | [second](inbox/2026-10-29-second.md) | Saved second... | t | note |",
    ].join("\n");
    const text = await handleBriefing(user, {});
    files["INDEX.md"] = INDEX;
    expect(text.indexOf("2026-10-29-second.md")).toBeLessThan(text.indexOf("2026-10-29-first.md"));
  });

  // protects: applies found through the chat briefing are credited to briefing; fails_when: the inbox branch skips recordSurfaceEvents; no_claim: the database write (mocked)
  it("records a briefing surface event for exactly the captures it lists", async () => {
    files["INDEX.md"] = CHAT_INDEX;
    await handleBriefing(user, {});
    files["INDEX.md"] = INDEX;
    expect(recordSurfaceEvents).toHaveBeenCalledWith(1, ["2026-10-29-ship-small.md", "2026-10-21-fewer-tools.md"], "briefing");
  });

  it("keeps the repo-only answer unchanged", async () => {
    const text = await handleBriefing(user, { repo: "o/r" });
    expect(text).not.toContain("xkg inbox");
  });
});
