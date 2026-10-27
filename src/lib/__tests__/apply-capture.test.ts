import { describe, it, expect, vi, beforeEach } from "vitest";
import type { User } from "../db";

/**
 * apply_capture is how xkg learns that a capture turned into code. Each call
 * should record the commit that applied it, including repeat applications of
 * a capture that already left the inbox.
 */

const readFile = vi.fn();
const githubPut = vi.fn();
const githubDelete = vi.fn();
const updateIndexEntry = vi.fn();
const rankByRelevance = vi.fn();
const generateApplicationSuggestions = vi.fn();

vi.mock("../rate-limit", () => ({ consumeQuota: vi.fn() }));
vi.mock("../llm", () => ({
  extractCapture: vi.fn(),
  detectSourceType: () => "text",
  formatDate: () => "2026-01-01",
  buildIndexRow: () => "row",
  rankByRelevance: (...a: unknown[]) => rankByRelevance(...a),
  composeBriefing: () => "",
  generateApplicationSuggestions: (...a: unknown[]) => generateApplicationSuggestions(...a),
  generatePlan: () => "",
  curateSingle: () => ({}),
  filterByDateRange: (f: unknown[]) => f,
  paginate: (i: unknown[]) => ({ items: i, total: i.length, offset: 0, limit: 10, hasMore: false }),
  pageFooter: () => "",
  matchIndexRows: (r: unknown[]) => r,
  llmSettings: () => ({}),
}));
vi.mock("../github", () => ({
  githubGet: vi.fn(),
  githubPut: (...a: unknown[]) => githubPut(...a),
  githubDelete: (...a: unknown[]) => githubDelete(...a),
  readFile: (...a: unknown[]) => readFile(...a),
  updateIndexEntry: (...a: unknown[]) => updateIndexEntry(...a),
}));
vi.mock("../fetch-source", () => ({ safeFetch: vi.fn() }));
vi.mock("../linking", () => ({ linkCapture: vi.fn() }));
vi.mock("../synthesis", () => ({ synthesizeTopic: vi.fn() }));

const { handleApplyCapture, handleApplyToContext } = await import("../mcp/handlers");

const llmUser = { id: 1, github_token: "t", github_repo: "o/r", llm_api_key: "k" } as unknown as User;
// No LLM key, so the best-effort re-synthesis is skipped
const user = { id: 1, github_token: "t", github_repo: "o/r", llm_api_key: null } as unknown as User;
const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const CAPTURE = "---\nstatus: inbox\n---\n## Core idea\nIdea.\n\n## Applied to\n_tbd_\n\n## Links to memory\n- none\n";

beforeEach(() => {
  readFile.mockReset();
  githubPut.mockReset();
  githubDelete.mockReset();
  updateIndexEntry.mockReset();
});

function writtenContent(): string {
  return githubPut.mock.calls[0]?.[3] as string;
}

describe("apply_capture", () => {
  it("moves an inbox capture to applied/ and logs the commit sha", async () => {
    readFile.mockImplementation((_t: string, _r: string, path: string) =>
      path === "inbox/2026-10-01-x.md" ? { content: CAPTURE, sha: "s1" } : null);

    const result = await handleApplyCapture(user, { filename: "inbox/2026-10-01-x.md", commit_sha: SHA, target_file: "src/a.ts" });

    expect(result).toBe("Applied: 2026-10-01-x.md → applied/2026-10-01-x.md (a1b2c3d)");
    expect(githubPut.mock.calls[0]?.[2]).toBe("applied/2026-10-01-x.md");
    expect(writtenContent()).toContain("status: applied");
    expect(writtenContent()).toContain(`- **Commit:** ${SHA}`);
    expect(writtenContent()).toMatch(/## Application log\n[\s\S]*\n## Links to memory/);
    expect(githubDelete).toHaveBeenCalledWith("t", "o/r", "inbox/2026-10-01-x.md", "s1", expect.any(String));
    expect(updateIndexEntry).toHaveBeenCalledWith("t", "o/r", "2026-10-01-x.md", "apply");
  });

  it("adds another log entry when an applied capture is applied again", async () => {
    const applied = CAPTURE.replace("status: inbox", "status: applied").replace(
      "## Links to memory",
      "## Application log\n- **Applied:** 2026-10-02\n- **Commit:** 1111111\n- **Outcome:** _pending_\n\n## Links to memory",
    );
    readFile.mockImplementation((_t: string, _r: string, path: string) =>
      path === "applied/2026-10-01-x.md" ? { content: applied, sha: "s2" } : null);

    const result = await handleApplyCapture(user, { filename: "2026-10-01-x.md", commit_sha: SHA });

    expect(result).toBe("Applied again: applied/2026-10-01-x.md (a1b2c3d)");
    expect(githubPut).toHaveBeenCalledWith("t", "o/r", "applied/2026-10-01-x.md", expect.any(String), expect.any(String), "s2");
    const content = writtenContent();
    expect(content.match(/## Application log/g)).toHaveLength(1);
    expect(content).toContain("- **Commit:** 1111111");
    expect(content).toMatch(new RegExp(`- \\*\\*Commit:\\*\\* ${SHA}[\\s\\S]*\\n## Links to memory`));
    expect(githubDelete).not.toHaveBeenCalled();
    expect(updateIndexEntry).not.toHaveBeenCalled();
  });

  it("rejects a commit_sha that is not a hash, without writing", async () => {
    const result = await handleApplyCapture(user, { filename: "2026-10-01-x.md", commit_sha: "HEAD" });
    expect(result).toMatch(/commit_sha must be a git commit hash/);
    expect(readFile).not.toHaveBeenCalled();
    expect(githubPut).not.toHaveBeenCalled();
  });

  it("still works without a commit sha", async () => {
    readFile.mockImplementation((_t: string, _r: string, path: string) =>
      path === "inbox/2026-10-01-x.md" ? { content: CAPTURE, sha: "s1" } : null);
    const result = await handleApplyCapture(user, { filename: "2026-10-01-x.md" });
    expect(result).toBe("Applied: 2026-10-01-x.md → applied/2026-10-01-x.md");
    expect(writtenContent()).not.toContain("**Commit:**");
  });
});

describe("apply_to_context", () => {
  it("names the captures it used and asks the agent to apply_capture after committing", async () => {
    readFile.mockImplementation((_t: string, _r: string, path: string) =>
      path === "INDEX.md" ? { content: "index", sha: "i" } : { content: `body of ${path}`, sha: "c" });
    rankByRelevance.mockResolvedValue([{ filename: "inbox/2026-10-01-x.md", score: 0.9 }]);
    generateApplicationSuggestions.mockResolvedValue("Change src/a.ts.");

    const result = await handleApplyToContext(llmUser, { task: "fix retries" });

    expect(generateApplicationSuggestions.mock.calls[0]?.[2]).toEqual(["File: inbox/2026-10-01-x.md\nbody of inbox/2026-10-01-x.md"]);
    expect(result).toContain("Change src/a.ts.");
    expect(result).toContain("inbox/2026-10-01-x.md");
    expect(result).toMatch(/apply_capture[\s\S]*commit sha/);
  });
});
