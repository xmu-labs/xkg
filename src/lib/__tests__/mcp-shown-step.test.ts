import { describe, it, expect, vi, beforeEach } from "vitest";
import type { User } from "../db";

/**
 * The setup funnel's "shown" step (XKG-150): an agent that finds a capture
 * through search or reads one with read_capture has been shown a capture,
 * even though neither writes a surface event.
 */

const files = new Map<string, string>();
vi.mock("../github", () => ({
  githubGet: async () => ({ ok: false }), githubPut: vi.fn(), githubDelete: vi.fn(),
  readFile: async (_t: string, _r: string, path: string) => (files.has(path) ? { content: files.get(path)!, sha: "s" } : null),
  updateIndexEntry: vi.fn(), appendToIndex: vi.fn(),
}));
const steps: Array<[number, string]> = [];
vi.mock("../setup-steps", () => ({
  recordSetupStep: async (userId: number, step: string) => { steps.push([userId, step]); },
}));

const { handleSearch, handleReadCapture } = await import("../mcp/handlers");
const user = { id: 7, github_token: "t", github_repo: "o/r" } as unknown as User;

beforeEach(() => {
  files.clear();
  steps.length = 0;
  files.set("INDEX.md", "| Date | Title |\n|---|---|\n| 2026-11-02 | [Alert owners](inbox/2026-11-02-alert-owners.md) |\n");
  files.set("inbox/2026-11-02-alert-owners.md", "# Alert owners");
  files.set("RULES.md", "# Rules");
});

describe("search and read_capture record the shown step", () => {
  // protects: Codex P2 on #188; fails_when: a found or read capture records no shown step; no_claim: once-only (see setup-steps tests)
  it("records it when search returns captures or read_capture returns one", async () => {
    await handleSearch(user, { query: "alert" });
    await handleReadCapture(user, { filename: "2026-11-02-alert-owners.md" });
    expect(steps).toEqual([[7, "shown"], [7, "shown"]]);
  });

  it("records nothing when nothing was shown", async () => {
    await handleSearch(user, { query: "kubernetes" });
    await handleReadCapture(user, { filename: "missing.md" });
    await handleReadCapture(user, { filename: "RULES.md" });
    expect(steps).toEqual([]);
  });
});
