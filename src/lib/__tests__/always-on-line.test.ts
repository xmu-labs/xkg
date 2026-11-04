import { describe, it, expect } from "vitest";
import { ALWAYS_ON_LINE, ALWAYS_ON_APPS } from "@/lib/always-on-line";
import { TOOLS } from "@/lib/mcp/tools";

/**
 * XKG-199: chat apps can't run the session-start hook and don't all read MCP
 * server instructions, but each has an always-on instruction slot. Settings
 * gives one line to paste there, the same for every app.
 */

describe("always-on line", () => {
  // protects: the line makes any app's AI start the briefing; fails_when: it names a tool the server doesn't have, or only one app; no_claim: each app obeys it (XKG-71 matrix)
  it("tells the AI to call the briefing tool when a chat starts or on 'brief me'", () => {
    expect(TOOLS.map((t) => t.name)).toContain("briefing");
    expect(ALWAYS_ON_LINE).toMatch(/xkg `?briefing`? tool/);
    expect(ALWAYS_ON_LINE).toMatch(/when a chat (or coding session )?starts/i);
    expect(ALWAYS_ON_LINE).toMatch(/brief me/i);
  });

  it("is short enough to paste into any app's instruction box", () => {
    expect(ALWAYS_ON_LINE.length).toBeLessThanOrEqual(300);
    expect(ALWAYS_ON_LINE).not.toMatch(/\n/);
  });

  it("names no single app, so one line works everywhere", () => {
    expect(ALWAYS_ON_LINE).not.toMatch(/claude|chatgpt|grok|gemini|codex|cursor/i);
  });

  // protects: the user knows where to paste it in each chat app; fails_when: an app from the ask is missing or has no place named; no_claim: the menu paths stay current
  it("says where to paste it in ChatGPT, Grok, Claude and Gemini", () => {
    expect(ALWAYS_ON_APPS.map((a) => a.app)).toEqual(["ChatGPT", "Grok", "Claude", "Gemini"]);
    for (const a of ALWAYS_ON_APPS) expect(a.where.length).toBeGreaterThan(5);
  });
});
