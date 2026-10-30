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
  readFileStrict: (...a: unknown[]) => readFile(...a),
  GitHubReadError: class extends Error {},
  updateIndexEntry: (...a: unknown[]) => updateIndexEntry(...a),
}));
vi.mock("../fetch-source", () => ({ safeFetch: vi.fn() }));
vi.mock("../linking", () => ({ linkCapture: vi.fn() }));
vi.mock("../synthesis", () => ({ synthesizeTopic: vi.fn() }));
const recordApplyEvent = vi.fn();
vi.mock("../apply-events", () => ({ recordApplyEvent: (...a: unknown[]) => recordApplyEvent(...a) }));
const forgetCapture = vi.fn();
vi.mock("../handoff-learning", async (original) => ({
  ...(await original<typeof import("../handoff-learning")>()),
  forgetCapture: (...a: unknown[]) => forgetCapture(...a),
}));

const { handleApplyCapture, handleApplyToContext, handleApplyStats, handleDeleteCapture } = await import("../mcp/handlers");

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
  recordApplyEvent.mockReset();
});

function writtenContent(): string {
  return githubPut.mock.calls[0]?.[3] as string;
}

function ledgerWrite(): unknown[] | undefined {
  return githubPut.mock.calls.find((c) => c[2] === "APPLIED.md");
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

  it("adds a row to the APPLIED.md ledger, creating it on first use", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
    readFile.mockImplementation((_t: string, _r: string, path: string) =>
      path === "inbox/2026-10-01-x.md" ? { content: CAPTURE, sha: "s1" } : null);

    await handleApplyCapture(user, { filename: "2026-10-01-x.md", commit_sha: SHA, target_file: "src/a.ts" });
    vi.useRealTimers();

    const call = ledgerWrite();
    expect(call?.[3]).toMatch(/\| 2026-10-27 \| 2026-10-01-x\.md \| a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 \| src\/a\.ts \|\n$/);
    expect(call?.[5]).toBeUndefined();
  });

  it("appends to an existing ledger on a repeat application, passing its sha", async () => {
    const applied = CAPTURE.replace("status: inbox", "status: applied");
    const ledger = "# Applied captures\n\n| Date | Capture | Commit | Target |\n| --- | --- | --- | --- |\n| 2026-10-20 | 2026-10-01-x.md | 1111111 | — |\n";
    readFile.mockImplementation((_t: string, _r: string, path: string) => {
      if (path === "applied/2026-10-01-x.md") return { content: applied, sha: "s2" };
      if (path === "APPLIED.md") return { content: ledger, sha: "L1" };
      return null;
    });

    await handleApplyCapture(user, { filename: "2026-10-01-x.md", commit_sha: SHA });

    const call = ledgerWrite();
    expect(call?.[3]).toContain("| 2026-10-20 | 2026-10-01-x.md | 1111111 | — |\n|");
    expect(call?.[3]).toMatch(/\| 2026-10-01-x\.md \| a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 \| — \|\n$/);
    expect(call?.[5]).toBe("L1");
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

  it("records nothing when this capture and commit are already in the ledger", async () => {
    // The git post-commit hook and the agent may both report the same commit
    const ledger = `| Date | Capture | Commit | Target |\n| --- | --- | --- | --- |\n| 2026-10-27 | 2026-10-01-x.md | ${SHA} | — |\n`;
    readFile.mockImplementation((_t: string, _r: string, path: string) => {
      if (path === "applied/2026-10-01-x.md") return { content: CAPTURE.replace("status: inbox", "status: applied"), sha: "s2" };
      if (path === "APPLIED.md") return { content: ledger, sha: "L1" };
      return null;
    });

    const result = await handleApplyCapture(user, { filename: "applied/2026-10-01-x.md", commit_sha: SHA.slice(0, 7) });

    expect(result).toBe("Already recorded: 2026-10-01-x.md (a1b2c3d)");
    expect(githubPut).not.toHaveBeenCalled();
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

describe("apply_capture counts on the server", () => {
  const inbox = (_t: string, _r: string, path: string) =>
    path === "inbox/2026-10-01-x.md" ? { content: CAPTURE, sha: "s1" } : null;

  it("records an event with the agent from the session and whether a reason was given", async () => {
    readFile.mockImplementation(inbox);
    await handleApplyCapture(user, { filename: "2026-10-01-x.md", commit_sha: SHA, applied_note: "Retries now back off" }, { harness: "codex" });
    expect(recordApplyEvent).toHaveBeenCalledWith({ userId: 1, filename: "2026-10-01-x.md", commit: SHA, harness: "codex", hasWhy: true });
  });

  it("records 'unknown' when the call came with no agent", async () => {
    readFile.mockImplementation(inbox);
    await handleApplyCapture(user, { filename: "2026-10-01-x.md" });
    expect(recordApplyEvent).toHaveBeenCalledWith(expect.objectContaining({ harness: "unknown", hasWhy: false }));
  });

  it("records a repeat application too", async () => {
    readFile.mockImplementation((_t: string, _r: string, path: string) =>
      path === "applied/2026-10-01-x.md" ? { content: CAPTURE.replace("inbox", "applied"), sha: "s2" } : null);
    await handleApplyCapture(user, { filename: "2026-10-01-x.md", commit_sha: SHA });
    expect(recordApplyEvent).toHaveBeenCalledTimes(1);
  });

  it("passes a repeat report to the server, so the agent and reason can join a commit the hook reported first", async () => {
    readFile.mockImplementation((_t: string, _r: string, path: string) => {
      if (path === "applied/2026-10-01-x.md") return { content: CAPTURE, sha: "s2" };
      if (path === "APPLIED.md") return { content: `| Date | Capture | Commit | Target |\n| --- | --- | --- | --- |\n| 2026-10-01 | 2026-10-01-x.md | ${SHA} | — |\n`, sha: "l1" };
      return null;
    });
    const result = await handleApplyCapture(user, { filename: "2026-10-01-x.md", commit_sha: SHA, applied_note: "Why" }, { harness: "codex" });
    expect(result).toBe("Already recorded: 2026-10-01-x.md (a1b2c3d)");
    expect(githubPut).not.toHaveBeenCalled();
    expect(recordApplyEvent).toHaveBeenCalledWith({ userId: 1, filename: "2026-10-01-x.md", commit: SHA, harness: "codex", hasWhy: true });
  });

  it("keeps the apply when the server count fails, and says it wasn't counted", async () => {
    readFile.mockImplementation(inbox);
    recordApplyEvent.mockRejectedValue(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await handleApplyCapture(user, { filename: "2026-10-01-x.md", commit_sha: SHA });
    expect(githubPut.mock.calls[0]?.[2]).toBe("applied/2026-10-01-x.md");
    expect(result).toContain("not counted on the server");
    expect(spy).toHaveBeenCalled();
    expect(String(spy.mock.calls[0])).not.toContain("2026-10-01-x");
    spy.mockRestore();
  });

  it("keeps the reason to one line of at most 200 characters", async () => {
    readFile.mockImplementation(inbox);
    await handleApplyCapture(user, { filename: "2026-10-01-x.md", applied_note: `line one\n## Injected heading\n${"x".repeat(300)}` });
    const note = writtenContent().match(/- \*\*Note:\*\* (.*)/)?.[1] ?? "";
    expect(note.length).toBeLessThanOrEqual(200);
    expect(writtenContent()).not.toContain("\n## Injected heading");
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
    expect(result).toContain("xkg-capture: <filename>");
  });
});

describe("apply_stats", () => {
  it("reports applications and commits per week from the ledger", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
    const ledger = "| Date | Capture | Commit | Target |\n| --- | --- | --- | --- |\n" +
      "| 2026-10-27 | a.md | a1b2c3d | — |\n| 2026-10-26 | b.md | — | — |\n| 2026-10-20 | c.md | ccccccc | — |\n";
    readFile.mockImplementation((_t: string, _r: string, path: string) =>
      path === "APPLIED.md" ? { content: ledger, sha: "L" } : null);

    const result = await handleApplyStats(user, { weeks: 2 });
    vi.useRealTimers();

    expect(result).toContain("Week of 2026-10-26: 2 applied, 1 with a commit");
    expect(result).toContain("Week of 2026-10-19: 1 applied, 1 with a commit");
    expect(result).toContain("Total: 3 applied, 2 with a commit");
  });

  it("says nothing has been applied yet when there is no ledger", async () => {
    readFile.mockResolvedValue(null);
    const result = await handleApplyStats(user, {});
    expect(result).toMatch(/No captures applied yet/);
  });
});

describe("apply_capture tool schema", () => {
  it("asks the agent for the reason in applied_note, in one short line", async () => {
    const { TOOLS } = await import("../mcp/tools");
    const tool = TOOLS.find((t) => t.name === "apply_capture")!;
    const note = (tool.inputSchema.properties as Record<string, { description: string }>).applied_note!.description;
    expect(note).toMatch(/why/i);
    expect(note).toMatch(/one line/i);
    expect(note).toMatch(/200/);
  });
});

describe("delete_capture", () => {
  // protects: what xkg learned from a capture's handoffs goes with it, so a new capture with its name starts fresh; fails_when: its learning stays after the delete, or is dropped when the delete didn't happen; no_claim: the statement itself (handoff-learning tests)
  it("forgets what was learned from the capture", async () => {
    forgetCapture.mockReset();
    readFile.mockImplementation((_t: string, _r: string, path: string) => (path === "inbox/2026-10-01-x.md" ? { content: CAPTURE, sha: "s1" } : null));
    expect(await handleDeleteCapture(user, { filename: "2026-10-01-x.md" })).toBe("Deleted: 2026-10-01-x.md");
    expect(forgetCapture).toHaveBeenCalledWith(1, "2026-10-01-x.md");

    forgetCapture.mockReset();
    expect(await handleDeleteCapture(user, { filename: "gone.md" })).toMatch(/^File not found/);
    expect(forgetCapture).not.toHaveBeenCalled();
  });
});
