import { describe, it, expect } from "vitest";
import { briefingCandidate, formatBriefing, selectRanked } from "../briefing";

/**
 * The briefing hands the agent captures that may fit the current work. xkg
 * never sees the user's code, so the text must not name code files: only the
 * agent, which can open them, decides where a capture applies.
 *
 * Not covered: whether the ranker picks good candidates, or whether a given
 * agent follows the task. Those need a real session.
 */

const INDEX = [
  "| 2026-10-20 | Server instructions | inbox/2026-10-20-server-instructions.md | Send setup on connect | mcp |",
  "| 2026-10-21 | Fewer tools | inbox/2026-10-21-fewer-tools.md | Agents pick better from 5 tools than 17 | mcp |",
  "| 2026-10-22 | Dedup | applied/2026-10-22-dedup.md | Hash content before saving | data |",
].join("\n");

function capture(title: string, core: string, takeaways: string[], appliedTo = "Use it in src/lib/foo.ts") {
  return `---
date: 2026-10-20
status: inbox
---

# ${title}

## Core idea
${core}

## Key takeaways
${takeaways.map((t) => `- ${t}`).join("\n")}

## Quotes
> quote

## Applied to
${appliedTo}

## Links to memory
_none yet_
`;
}

const FEWER = briefingCandidate(
  "inbox/2026-10-21-fewer-tools.md",
  0.82,
  "The repo is an MCP server with many tools",
  capture("Fewer tools", "Agents choose better from a short tool list.", ["Merge read tools", "Keep names verbs", "Drop rare tools", "A fourth point"]),
);
const INSTR = briefingCandidate(
  "inbox/2026-10-20-server-instructions.md",
  0.64,
  "Recent commits touch MCP setup",
  capture("Server instructions", "Tell the agent how to set up on connect.", ["Keep it short"]),
);

describe("briefingCandidate", () => {
  it("reads the title, main idea and the first 3 key points", () => {
    expect(FEWER).toEqual({
      filename: "inbox/2026-10-21-fewer-tools.md",
      score: 0.82,
      reason: "The repo is an MCP server with many tools",
      title: "Fewer tools",
      coreIdea: "Agents choose better from a short tool list.",
      keyPoints: ["Merge read tools", "Keep names verbs", "Drop rare tools"],
    });
  });

  it("falls back to the filename when a capture has none of the usual sections", () => {
    const c = briefingCandidate("inbox/2026-01-01-hand-note.md", 0.5, "why", "just a hand-written note");
    expect(c.title).toBe("2026-01-01-hand-note");
    expect(c.coreIdea).toBe("");
    expect(c.keyPoints).toEqual([]);
  });

  // Regression: ISSUE-001 — a capture saved with Windows line endings lost its main idea and key points
  // Found by /qa on 2026-10-28
  it("reads a capture saved with Windows line endings", () => {
    const c = briefingCandidate("inbox/a.md", 0.5, "why", capture("T", "Core.", ["one", "two"]).replace(/\n/g, "\r\n"));
    expect(c.title).toBe("T");
    expect(c.coreIdea).toBe("Core.");
    expect(c.keyPoints).toEqual(["one", "two"]);
  });

  it("cuts long text so the briefing stays small in the agent's context", () => {
    const c = briefingCandidate("inbox/a.md", 0.5, "why", capture("T", "x".repeat(1000), ["y".repeat(500)]));
    expect(c.coreIdea.length).toBeLessThanOrEqual(400);
    expect(c.coreIdea.endsWith("…")).toBe(true);
    expect(c.keyPoints[0]!.length).toBeLessThanOrEqual(200);
  });
});

describe("selectRanked", () => {
  it("keeps captures scored 0.3 or more, best first, at most 5", () => {
    const ranked = [0.9, 0.2, 0.8, 0.7, 0.6, 0.5, 0.4].map((score, i) => ({
      filename: `inbox/2026-10-0${i}-c.md`,
      score,
      reason: `r${i}`,
    }));
    const index = ranked.map((r) => `| 2026-10-01 | C | ${r.filename} | s | t |`).join("\n");
    const kept = selectRanked(ranked, index);
    expect(kept.map((r) => r.score)).toEqual([0.9, 0.8, 0.7, 0.6, 0.5]);
  });

  it("drops files the ranker named that are not in the index", () => {
    const kept = selectRanked(
      [
        { filename: "RULES.md", score: 0.9, reason: "x" },
        { filename: "src/lib/llm.ts", score: 0.9, reason: "x" },
        { filename: "applied/2026-10-22-dedup.md", score: 0.6, reason: "x" },
      ],
      INDEX,
    );
    expect(kept.map((r) => r.filename)).toEqual(["applied/2026-10-22-dedup.md"]);
  });

  it("lists a capture once when the ranker repeats it", () => {
    const f = "inbox/2026-10-21-fewer-tools.md";
    const kept = selectRanked([{ filename: f, score: 0.5, reason: "a" }, { filename: f, score: 0.7, reason: "b" }], INDEX);
    expect(kept).toEqual([{ filename: f, score: 0.7, reason: "b" }]);
  });

  it("ignores ranker output that is not a list of results", () => {
    expect(selectRanked({ filename: "x" }, INDEX)).toEqual([]);
    expect(selectRanked([{ filename: "inbox/2026-10-21-fewer-tools.md", score: "high" }], INDEX)).toEqual([]);
  });
});

describe("formatBriefing", () => {
  const text = formatBriefing([FEWER, INSTR], "");

  it("tells the agent to check each candidate against the code before suggesting it", () => {
    expect(text).toMatch(/^xkg briefing: 2 captures may fit this work\. xkg has not seen your code/);
    expect(text).toMatch(/read the code/i);
    expect(text).toMatch(/name a file you opened/i);
    expect(text).toMatch(/at most 3/);
    expect(text).toMatch(/ask before changing anything/i);
    expect(text).toContain("xkg-capture: <filename>");
    expect(text).toContain("`apply_capture`");
    expect(text).toContain("call `search_captures` with no query");
  });

  it("lists candidates in rank order with filename, fit, reason, main idea and key points", () => {
    expect(text.indexOf("Fewer tools")).toBeLessThan(text.indexOf("Server instructions"));
    expect(text).toContain("### 1. Fewer tools (inbox/2026-10-21-fewer-tools.md, fit 82%)");
    expect(text).toContain("Why it may fit: The repo is an MCP server with many tools");
    expect(text).toContain("Main idea: Agents choose better from a short tool list.");
    expect(text).toContain("- Drop rare tools");
    expect(text).not.toContain("A fourth point");
  });

  it("names no file except the candidates, not even the capture's own guess", () => {
    const paths = text.match(/[\w./-]+\.[a-z]{2,4}\b/g) ?? [];
    expect(paths.filter((p) => !/^(inbox|applied|archived)\/[\w.-]+\.md$/.test(p))).toEqual([]);
    expect(text).not.toContain("Applied to");
  });

  it("points to the full capture list when nothing fits", () => {
    // search_captures lists inbox, applied and archived captures; list_inbox only the inbox
    expect(formatBriefing([], "")).toBe(
      "xkg briefing: no capture looks related to this repo's recent work. To check every capture, call `search_captures` with no query and page through the results.",
    );
  });

  it("adds the rules, cut to 1,500 characters with a pointer to the rest", () => {
    expect(formatBriefing([FEWER], "Short rules")).toMatch(/## Rules\nShort rules$/);
    const long = formatBriefing([FEWER], "r".repeat(3000));
    const rules = long.slice(long.indexOf("## Rules\n") + "## Rules\n".length);
    expect(rules.length).toBeLessThan(1600);
    expect(rules).toContain("call `get_rules` for the rest");
  });

  it("leaves the rules out when there are none", () => {
    expect(text).not.toContain("## Rules");
  });
});
