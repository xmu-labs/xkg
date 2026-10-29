import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WhereResult } from "../where";

/**
 * HANDOFFS.md: captures waiting for the user's coding agent, one row per
 * capture and repo, in the knowledge repo like APPLIED.md. xkg updates the
 * table; the user can edit the file, so text around the table is kept.
 */

const files = new Map<string, { content: string; sha: string }>();
let shaN = 0;
let putFailures = 0;
const githubPut = vi.fn(async (_t: string, _r: string, path: string, content: string, _m: string, sha?: string) => {
  if (putFailures > 0) {
    putFailures--;
    throw new Error("GitHub PUT HANDOFFS.md: HTTP 409");
  }
  const current = files.get(path);
  if (current && current.sha !== sha) throw new Error("GitHub PUT HANDOFFS.md: HTTP 409");
  files.set(path, { content, sha: `sha${++shaN}` });
});

vi.mock("../github", () => ({
  githubPut: (...a: Parameters<typeof githubPut>) => githubPut(...a),
  readFile: async (_t: string, _r: string, path: string) => files.get(path) ?? null,
}));

const { HANDOFFS_PATH, parseHandoffs, renderHandoffs, upsertHandoff, autoHandoff, queueHandoff } = await import("../handoffs");
type Row = import("../handoffs").HandoffRow;

const row = (over: Partial<Row> = {}): Row => ({
  capture: "inbox/2026-10-29-llm-memory.md",
  repo: "acme/app",
  kind: "code",
  files: ["src/llm.ts", "src/briefing.ts"],
  fit: "strong",
  status: "pending",
  since: "2026-10-29",
  source: "auto",
  ...over,
});

const strong: WhereResult = {
  repo: "acme/app", tier: "strong", files: [{ path: "src/llm.ts", why: "`rank` sends the whole index" }, { path: "src/briefing.ts" }],
  also: [{ repo: "acme/web", tier: "possible" }], scorer: "evidence", modelConf: null,
};

beforeEach(() => {
  files.clear();
  githubPut.mockClear();
  putFailures = 0;
});

describe("HANDOFFS.md format", () => {
  // protects: the file is the queue's source of truth; fails_when: a row doesn't survive a write and a read; no_claim: the intro wording
  it("reads back every field it writes, files and all", () => {
    const rows = [row(), row({ capture: "inbox/2026-10-28-review.md", files: [], fit: "possible", status: "snoozed:2026-11-05", since: "2026-10-28", source: "button" })];
    const text = renderHandoffs(rows);
    expect(text).toContain("| capture | repo | kind | files | fit | status | since | source |");
    expect(text).toContain("| inbox/2026-10-29-llm-memory.md | acme/app | code | src/llm.ts, src/briefing.ts | strong | pending | 2026-10-29 | auto |");
    expect(text).toContain("| inbox/2026-10-28-review.md | acme/app | code | — | possible | snoozed:2026-11-05 | 2026-10-28 | button |");
    expect(parseHandoffs(text).rows).toEqual(rows);
  });

  // protects: a pipe in a path can't break the table; fails_when: a cell with "|" splits into two; no_claim: none
  it("escapes table characters in cells", () => {
    const odd = row({ files: ["src/a|b.ts"] });
    expect(parseHandoffs(renderHandoffs([odd])).rows).toEqual([odd]);
  });

  // protects: the user may edit the file; fails_when: text the user wrote around the table is lost on the next write; no_claim: edits inside the table
  it("keeps the text around the table", () => {
    const text = `# My queue\n\nNotes I wrote.\n\n${renderHandoffs([row()]).split("\n").slice(4).join("\n")}\nMore notes.\n`;
    const parsed = parseHandoffs(text);
    expect(parsed.rows).toEqual([row()]);
    const again = renderHandoffs([row({ status: "pending", since: "2026-10-30" })], parsed);
    expect(again.startsWith("# My queue\n\nNotes I wrote.\n\n| capture |")).toBe(true);
    expect(again.endsWith("\nMore notes.\n")).toBe(true);
  });
});

describe("upsertHandoff", () => {
  // protects: AC2, one row per capture and repo, newest first; fails_when: queuing the same pair twice leaves two rows; no_claim: none
  it("updates the row for the same capture and repo and moves it to the top", () => {
    const other = row({ capture: "inbox/2026-10-27-other.md", since: "2026-10-27" });
    const first = upsertHandoff([other], row());
    expect(first.rows.map((r) => r.capture)).toEqual(["inbox/2026-10-29-llm-memory.md", "inbox/2026-10-27-other.md"]);
    const again = upsertHandoff(first.rows, row({ source: "button", files: ["src/llm.ts"] }));
    expect(again.rows).toHaveLength(2);
    expect(again.rows[0]).toEqual(row({ source: "button", files: ["src/llm.ts"] }));
  });

  // protects: an applied capture moved to applied/ is still the same capture; fails_when: inbox/x.md and applied/x.md make two rows; no_claim: archived captures
  it("matches a capture by name whatever its folder", () => {
    const { rows } = upsertHandoff([row({ capture: "applied/2026-10-29-llm-memory.md", status: "applied" })], row());
    expect(rows).toEqual([row()]);
  });

  // protects: the same capture can wait in two repos; fails_when: queuing it for a second repo drops the first; no_claim: none
  it("keeps one row per repo", () => {
    const { rows } = upsertHandoff([row()], row({ repo: "acme/web", files: [] }));
    expect(rows.map((r) => r.repo)).toEqual(["acme/web", "acme/app"]);
  });

  // protects: a dead end is never offered again in that repo; fails_when: queuing a dead pair makes it pending; no_claim: how a row becomes dead
  it("leaves a dead row dead", () => {
    const dead = row({ status: "dead" });
    const result = upsertHandoff([dead], row({ source: "button" }));
    expect(result.changed).toBe(false);
    expect(result.row).toEqual(dead);
  });

  // protects: saving the same handoff twice doesn't commit twice; fails_when: an identical row reports a change; no_claim: none
  it("reports no change for an identical row", () => {
    expect(upsertHandoff([row()], row()).changed).toBe(false);
  });
});

describe("autoHandoff", () => {
  // protects: AC2 (D1), only a Strong fit with files queues on its own; fails_when: a Possible or empty match queues, or a Strong one doesn't; no_claim: the tier is right
  it("queues a Strong fit with files, and nothing else", () => {
    expect(autoHandoff("inbox/2026-10-29-llm-memory.md", strong, "2026-10-29")).toEqual(row());
    expect(autoHandoff("inbox/x.md", { ...strong, tier: "possible" }, "2026-10-29")).toBeNull();
    expect(autoHandoff("inbox/x.md", { ...strong, files: [] }, "2026-10-29")).toBeNull();
    expect(autoHandoff("inbox/x.md", { ...strong, repo: null, tier: "none", files: [], noFit: { reason: "weak" } }, "2026-10-29")).toBeNull();
  });
});

describe("queueHandoff", () => {
  // protects: the queue is created on first use; fails_when: the first handoff needs an existing file; no_claim: none
  it("creates HANDOFFS.md with the row", async () => {
    const result = await queueHandoff("t", "o/k", row());
    expect(result).toEqual({ row: row(), changed: true });
    expect(githubPut).toHaveBeenCalledWith("t", "o/k", HANDOFFS_PATH, renderHandoffs([row()]), expect.stringContaining("2026-10-29-llm-memory.md"), undefined);
  });

  // protects: writes don't clobber a newer file; fails_when: an update is sent without the file's sha; no_claim: none
  it("updates the file with its sha", async () => {
    files.set(HANDOFFS_PATH, { content: renderHandoffs([row({ capture: "inbox/a.md" })]), sha: "s1" });
    await queueHandoff("t", "o/k", row());
    expect(githubPut.mock.calls[0]![5]).toBe("s1");
    expect(parseHandoffs(files.get(HANDOFFS_PATH)!.content).rows.map((r) => r.capture)).toEqual(["inbox/2026-10-29-llm-memory.md", "inbox/a.md"]);
  });

  // protects: a conflicting write is retried once from a fresh read; fails_when: one 409 loses the row; no_claim: none
  it("re-reads and retries once after a failed write", async () => {
    putFailures = 1;
    const result = await queueHandoff("t", "o/k", row());
    expect(result?.changed).toBe(true);
    expect(githubPut).toHaveBeenCalledTimes(2);
    expect(parseHandoffs(files.get(HANDOFFS_PATH)!.content).rows).toEqual([row()]);
  });

  // protects: a capture never fails because of the queue; fails_when: a second failure throws; no_claim: none
  it("gives up quietly after the retry fails", async () => {
    putFailures = 2;
    await expect(queueHandoff("t", "o/k", row())).resolves.toBeNull();
    expect(githubPut).toHaveBeenCalledTimes(2);
  });

  // protects: no empty commits; fails_when: an unchanged queue is written again; no_claim: none
  it("doesn't write when nothing changed", async () => {
    files.set(HANDOFFS_PATH, { content: renderHandoffs([row()]), sha: "s1" });
    expect(await queueHandoff("t", "o/k", row())).toEqual({ row: row(), changed: false });
    expect(githubPut).not.toHaveBeenCalled();
  });
});
