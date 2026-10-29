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

const {
  HANDOFFS_PATH, parseHandoffs, renderHandoffs, upsertHandoff, autoHandoff, queueHandoff,
  setHandoffStatus, pruneFinished, handoffFor, readHandoffs, handoffLogLine, appendHandoffLog, addDays, parseHandoffLog, markDead,
} = await import("../handoffs");
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
  // protects: a file name with ", " or "%" stays one file; fails_when: a round trip splits or changes a path; no_claim: none
  it("keeps paths with commas and percent signs whole", () => {
    const odd = row({ files: ["src/a, b.ts", "docs/50%,off.md", "src/plain.ts"] });
    const text = renderHandoffs([odd]);
    expect(parseHandoffs(text).rows).toEqual([odd]);
    expect(text).toContain("src/plain.ts");
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

describe("HANDOFFS.md rows xkg can't read", () => {
  // Regression: ISSUE-001 — a write dropped table rows xkg couldn't read (a row the user typed, a kind from a later version)
  // Found by /qa on 2026-10-29
  // Report: .gstack/qa-reports/run-20261029T201121Z/qa-report-handoffs-2026-10-29.md
  // protects: rows the user typed in the table survive xkg's next write; fails_when: an unreadable table line is dropped on render; no_claim: GitHub's behavior (in-memory fake)
  it("keeps them, as written, below its own rows", () => {
    const theirs = ["| inbox/2026-10-02-flow.md | acme/app | workflow | — | strong | pending | 2026-10-02 | auto |", "| my own note about acme/app | | | | | | | |"];
    const text = `${renderHandoffs([row()])}${theirs.join("\n")}\n`;
    const parsed = parseHandoffs(text);
    expect(parsed.rows).toEqual([row()]);
    const { rows } = upsertHandoff(parsed.rows, row({ repo: "acme/web" }));
    const again = renderHandoffs(rows, parsed);
    for (const line of theirs) expect(again).toContain(`${line}\n`);
    expect(parseHandoffs(again).rows.map((r) => r.repo)).toEqual(["acme/web", "acme/app"]);
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

describe("setHandoffStatus", () => {
  // protects: a row records when it got its status, so a snooze or an answer starts its own clock; fails_when: since keeps the queue date; no_claim: none
  it("sets the status and the date it changed, leaving dead rows and other repos alone", async () => {
    const rows = [row(), row({ repo: "acme/web" }), row({ capture: "inbox/dead.md", status: "dead" })];
    files.set(HANDOFFS_PATH, { content: renderHandoffs(rows), sha: "s1" });
    expect(await setHandoffStatus("t", "o/k", [row(), row({ capture: "inbox/dead.md" })], "declined", "2026-11-02"))
      .toEqual([row({ status: "declined", since: "2026-11-02" })]);
    expect(parseHandoffs(files.get(HANDOFFS_PATH)!.content).rows).toEqual([
      row({ status: "declined", since: "2026-11-02" }), row({ repo: "acme/web" }), row({ capture: "inbox/dead.md", status: "dead" }),
    ]);
  });

  // protects: a status change lands only on the row as it was read, so an edit or answer made meanwhile is kept; fails_when: a row whose status or date changed since the read is overwritten; no_claim: none
  it("changes a row only if it's unchanged since it was read", async () => {
    const read = row();
    files.set(HANDOFFS_PATH, { content: renderHandoffs([row({ status: "done" }), row({ capture: "inbox/b.md" })]), sha: "s1" });
    await setHandoffStatus("t", "o/k", [read, row({ capture: "inbox/b.md" })], "expired", "2026-10-30");
    expect(parseHandoffs(files.get(HANDOFFS_PATH)!.content).rows.map((r) => r.status)).toEqual(["done", "expired"]);
  });

  // protects: callers know which rows changed, so they count only those; fails_when: a skipped row is reported as set, or a failed write as nothing to do; no_claim: none
  it("returns the rows it set, or null when the write failed", async () => {
    files.set(HANDOFFS_PATH, { content: renderHandoffs([row({ status: "done" }), row({ capture: "inbox/b.md" })]), sha: "s1" });
    expect(await setHandoffStatus("t", "o/k", [row(), row({ capture: "inbox/b.md" })], "expired", "2026-10-30"))
      .toEqual([row({ capture: "inbox/b.md", status: "expired", since: "2026-10-30" })]);
    putFailures = 2;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    files.set(HANDOFFS_PATH, { content: renderHandoffs([row()]), sha: "s1" });
    expect(await setHandoffStatus("t", "o/k", [row()], "expired", "2026-10-30")).toBeNull();
    spy.mockRestore();
  });

  // protects: the re-read after a conflict is checked the same way; fails_when: the retry overwrites a row the conflicting write changed; no_claim: none
  it("checks again on the retry after a conflict", async () => {
    files.set(HANDOFFS_PATH, { content: renderHandoffs([row()]), sha: "s1" });
    githubPut.mockImplementationOnce(async () => {
      files.set(HANDOFFS_PATH, { content: renderHandoffs([row({ status: "snoozed:2026-11-05" })]), sha: "s2" });
      throw new Error("GitHub PUT HANDOFFS.md: HTTP 409");
    });
    await setHandoffStatus("t", "o/k", [row()], "expired", "2026-10-30");
    expect(parseHandoffs(files.get(HANDOFFS_PATH)!.content).rows[0]!.status).toBe("snoozed:2026-11-05");
  });
});

describe("markDead", () => {
  // protects: a capture turned down twice in a repo is never offered there again; fails_when: another repo's row, another capture's row or an already dead row changes; no_claim: when it's called (handoff-learning tests)
  it("marks the capture's rows in those repos dead", async () => {
    const rows = [row({ status: "declined" }), row({ repo: "acme/web" }), row({ capture: "inbox/b.md" }), row({ capture: "inbox/c.md", status: "dead" })];
    files.set(HANDOFFS_PATH, { content: renderHandoffs(rows), sha: "s1" });
    expect(await markDead("t", "o/k", "applied/2026-10-29-llm-memory.md", ["ACME/app"], "2026-11-03"))
      .toEqual([row({ status: "dead", since: "2026-11-03" })]);
    expect(parseHandoffs(files.get(HANDOFFS_PATH)!.content).rows.map((r) => r.status)).toEqual(["dead", "pending", "pending", "dead"]);
    githubPut.mockClear();
    expect(await markDead("t", "o/k", "inbox/2026-10-29-llm-memory.md", ["acme/app"], "2026-11-04")).toEqual([]);
    expect(githubPut).not.toHaveBeenCalled();
  });
});

describe("finished rows", () => {
  // protects: HANDOFFS.md stays short, the history lives in each capture's Handoff log; fails_when: a finished row older than 90 days is kept, or a waiting, dead or recent row is dropped; no_claim: none
  it("drops applied, declined, done and expired rows 90 days after their last change", () => {
    const today = "2026-12-31";
    const old = "2026-10-01";
    const rows = [
      row({ capture: "inbox/a.md", status: "applied", since: old }),
      row({ capture: "inbox/b.md", status: "declined", since: old }),
      row({ capture: "inbox/c.md", status: "done", since: old }),
      row({ capture: "inbox/d.md", status: "expired", since: old }),
      row({ capture: "inbox/e.md", status: "applied", since: "2026-10-02" }),
      row({ capture: "inbox/f.md", status: "pending", since: old }),
      row({ capture: "inbox/g.md", status: "dead", since: old }),
      row({ capture: "inbox/h.md", status: "snoozed:2026-10-08", since: old }),
    ];
    expect(pruneFinished(rows, today).map((r) => r.capture)).toEqual(["inbox/e.md", "inbox/f.md", "inbox/g.md", "inbox/h.md"]);
  });

  // protects: pruning rides on writes xkg makes anyway; fails_when: a status change keeps old finished rows, or a read alone writes; no_claim: none
  it("are dropped on the next write", async () => {
    files.set(HANDOFFS_PATH, { content: renderHandoffs([row(), row({ capture: "inbox/old.md", status: "applied", since: "2026-01-01" })]), sha: "s1" });
    await setHandoffStatus("t", "o/k", [row()], "done", "2026-10-30");
    expect(parseHandoffs(files.get(HANDOFFS_PATH)!.content).rows.map((r) => r.capture)).toEqual(["inbox/2026-10-29-llm-memory.md"]);
  });
});

describe("addDays", () => {
  // protects: snooze and pruning dates cross months and years; fails_when: date math drifts; no_claim: none
  it("adds and subtracts calendar days", () => {
    expect(addDays("2026-12-28", 7)).toBe("2027-01-04");
    expect(addDays("2026-10-01", -90)).toBe("2026-07-03");
  });
});

describe("handoffFor", () => {
  const rows = [row(), row({ repo: "acme/web", status: "declined" }), row({ capture: "inbox/two.md" }), row({ capture: "inbox/two.md", repo: "acme/web" })];

  // protects: an answer lands on the row for that repo; fails_when: the repo is ignored or its case matters; no_claim: none
  it("finds the row for the capture and repo, whatever its folder or case", () => {
    expect(handoffFor(rows, "applied/2026-10-29-llm-memory.md", "ACME/Web")).toEqual(rows[1]);
    expect(handoffFor(rows, "2026-10-29-llm-memory.md", "acme/other")).toBeNull();
  });

  // protects: an agent that leaves out repo still answers the one waiting handoff, and never guesses between two; fails_when: a finished row is picked, or one of two waiting rows is; no_claim: none
  it("without a repo, finds the capture's only waiting row", () => {
    expect(handoffFor(rows, "2026-10-29-llm-memory.md")).toEqual(rows[0]);
    expect(handoffFor(rows, "two.md")).toBeNull();
    expect(handoffFor(rows, "none.md")).toBeNull();
  });
});

describe("readHandoffs", () => {
  // protects: answers work before the queue exists; fails_when: a missing file throws; no_claim: none
  it("reads the rows, or none when there is no file", async () => {
    expect(await readHandoffs("t", "o/k")).toEqual([]);
    files.set(HANDOFFS_PATH, { content: renderHandoffs([row()]), sha: "s1" });
    expect(await readHandoffs("t", "o/k")).toEqual([row()]);
  });
});

describe("Handoff log", () => {
  // protects: each answer is kept in the capture, with no free text, so learning can be rebuilt from git; fails_when: a field is lost or a note sneaks in; no_claim: none
  it("writes one line per answer", () => {
    expect(handoffLogLine({ date: "2026-10-30", repo: "acme/app", outcome: "declined", reason: "wrong-files", confidence: "high" }))
      .toBe("- 2026-10-30 · acme/app · declined (wrong-files) · confidence high");
    expect(handoffLogLine({ date: "2026-10-30", repo: "acme/app", outcome: "applied", commit: "a".repeat(40), files: ["src/a.ts", "src/b.ts"] }))
      .toBe(`- 2026-10-30 · acme/app · applied · commit ${"a".repeat(40)} · files src/a.ts, src/b.ts`);
    expect(handoffLogLine({ date: "2026-10-30", outcome: "reverted", commit: "b".repeat(40) })).toBe(`- 2026-10-30 · reverted · commit ${"b".repeat(40)}`);
    // Written like HANDOFFS.md's list, so a path with ", " stays one path
    expect(handoffLogLine({ date: "2026-10-30", outcome: "applied", files: ["src/a, b.ts", "src/c.ts"] })).toBe("- 2026-10-30 · applied · files src/a%2C b.ts, src/c.ts");
  });

  // protects: learning is rebuilt from the capture alone; fails_when: a field written by handoffLogLine doesn't read back, or other text reads as an answer; no_claim: none
  it("reads back every line it wrote, and nothing else", () => {
    const entries = [
      { date: "2026-10-30", repo: "acme/app", outcome: "declined", reason: "wrong-files", confidence: "high", files: ["src/a.ts"] },
      { date: "2026-10-31", repo: "acme/app", outcome: "applied", commit: "a".repeat(40), files: ["src/a, b.ts", "src/c%d.ts"] },
      { date: "2026-11-01", outcome: "reverted", commit: "b".repeat(7) },
      { date: "2026-11-02", repo: "acme/web", outcome: "later" },
    ];
    const content = entries.reduce(
      (c, e) => appendHandoffLog(c, handoffLogLine(e)),
      "# T\n\n## Core idea\nIdea.\n- 2026-10-01 · acme/app · applied\n\n## Links to memory\n- none\n",
    );
    expect(parseHandoffLog(`${content}- not a log line\n`)).toEqual(entries);
    expect(parseHandoffLog("# T\n\n## Core idea\nIdea.\n")).toEqual([]);
  });

  // protects: the log sits with the capture's other logs and grows in place; fails_when: a second section is added or it lands after Links to memory; no_claim: none
  it("adds the section before Links to memory, then appends to it", () => {
    const capture = "# T\n\n## Core idea\nIdea.\n\n## Links to memory\n- none\n";
    const once = appendHandoffLog(capture, "- one");
    expect(once).toBe("# T\n\n## Core idea\nIdea.\n\n## Handoff log\n- one\n\n## Links to memory\n- none\n");
    const twice = appendHandoffLog(once, "- two");
    expect(twice).toBe("# T\n\n## Core idea\nIdea.\n\n## Handoff log\n- one\n- two\n\n## Links to memory\n- none\n");
    expect(appendHandoffLog("# T\n\nBody.\n", "- one")).toBe("# T\n\nBody.\n\n## Handoff log\n- one\n");
    expect(appendHandoffLog(appendHandoffLog("# T\n\nBody.\n", "- one"), "- two")).toBe("# T\n\nBody.\n\n## Handoff log\n- one\n- two\n");
  });
});
