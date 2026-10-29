import { describe, it, expect, vi, beforeEach } from "vitest";
import type { User } from "../db";

/**
 * apply_capture records what the user answered to "Apply this now?": applied
 * (the default), declined, done, later or reverted. Only an apply moves the
 * capture, adds an APPLIED.md row and counts in apply_events. Every answer
 * updates the capture's row in HANDOFFS.md and adds a line to its Handoff log.
 * No argument carries spec text, code or a diff.
 *
 * Not covered: the git hook that reports applies and reverts (git-hook tests),
 * what handoff_events store (handoff-events tests).
 */

const files: Record<string, { content: string; sha: string }> = {};
let shaN = 0;
const githubPut = vi.fn(async (_t: string, _r: string, path: string, content: string, _m: string, sha?: string) => {
  if (sha && files[path] && files[path]!.sha !== sha) throw new Error(`GitHub PUT ${path}: HTTP 409`);
  files[path] = { content, sha: `sha${++shaN}` };
});
const githubDelete = vi.fn(async (_t: string, _r: string, path: string) => {
  delete files[path];
});
const recordApplyEvent = vi.fn();
const recordHandoffEvent = vi.fn();
const codeMapPaths = vi.fn();

vi.mock("../rate-limit", () => ({ consumeQuota: vi.fn() }));
vi.mock("../llm", async (orig) => ({ ...(await orig<typeof import("../llm")>()), formatDate: () => "2026-10-30" }));
vi.mock("../github", () => ({
  githubGet: vi.fn(),
  githubPut: (...a: Parameters<typeof githubPut>) => githubPut(...a),
  githubDelete: (...a: Parameters<typeof githubDelete>) => githubDelete(...a),
  readFile: async (_t: string, _r: string, path: string) => files[path] ?? null,
  updateIndexEntry: vi.fn(),
}));
vi.mock("../db", async (orig) => ({ ...(await orig<typeof import("../db")>()), codeMapPaths: (...a: unknown[]) => codeMapPaths(...a) }));
vi.mock("../apply-events", async (orig) => ({ ...(await orig<typeof import("../apply-events")>()), recordApplyEvent: (...a: unknown[]) => recordApplyEvent(...a) }));
vi.mock("../handoff-events", () => ({ recordHandoffEvent: (...a: unknown[]) => recordHandoffEvent(...a) }));
vi.mock("../surface-events", () => ({ recordSurfaceEvents: vi.fn(), recordWhereEvent: vi.fn() }));
vi.mock("../linking", () => ({ linkCapture: vi.fn() }));
vi.mock("../synthesis", () => ({ synthesizeTopic: vi.fn() }));

const { handleApplyCapture } = await import("../mcp/handlers");
const { renderHandoffs, parseHandoffs } = await import("../handoffs");
const { offerable } = await import("../handoff-offer");
type Row = import("../handoffs").HandoffRow;

const user = { id: 1, github_token: "t", github_repo: "o/k", llm_api_key: null } as unknown as User;
const NAME = "2026-10-28-llm-memory.md";
const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const CAPTURE = "---\nstatus: inbox\n---\n\n# LLM memory\n\n## Core idea\nIdea.\n\n## Applied to\n_tbd_\n\n## Links to memory\n- none\n";
const row = (over: Partial<Row> = {}): Row => ({
  capture: `inbox/${NAME}`, repo: "acme/app", kind: "code", files: ["src/llm.ts"], fit: "strong", status: "pending", since: "2026-10-28", source: "auto", ...over,
});

function setup(rows: Row[] = [row()]) {
  for (const k of Object.keys(files)) delete files[k];
  files[`inbox/${NAME}`] = { content: CAPTURE, sha: "c1" };
  if (rows.length) files["HANDOFFS.md"] = { content: renderHandoffs(rows), sha: "h1" };
}
const handoffs = () => parseHandoffs(files["HANDOFFS.md"]!.content).rows;
const everything = () => JSON.stringify(files) + JSON.stringify(recordHandoffEvent.mock.calls) + JSON.stringify(recordApplyEvent.mock.calls);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-30T12:00:00Z"));
  githubPut.mockClear();
  githubDelete.mockClear();
  recordApplyEvent.mockReset();
  recordHandoffEvent.mockReset();
  codeMapPaths.mockReset().mockResolvedValue(new Set(["src/llm.ts", "src/briefing.ts"]));
  return () => vi.useRealTimers();
});

describe("answers that aren't applies", () => {
  // protects: AC10, only an apply counts as one; fails_when: declined, done or later moves the capture, writes APPLIED.md or an apply_events row; no_claim: none
  it.each(["declined", "done", "later"])("%s leaves the capture in inbox/ and counts no apply", async (outcome) => {
    setup();
    await handleApplyCapture(user, { filename: NAME, outcome, repo: "acme/app" });
    expect(files[`inbox/${NAME}`]).toBeDefined();
    expect(files[`applied/${NAME}`]).toBeUndefined();
    expect(files["APPLIED.md"]).toBeUndefined();
    expect(githubDelete).not.toHaveBeenCalled();
    expect(recordApplyEvent).not.toHaveBeenCalled();
  });

  // protects: each answer updates its row and is counted with its detail; fails_when: the status, its date or the event is wrong; no_claim: none
  it("updates the row and records the event", async () => {
    setup();
    expect(await handleApplyCapture(user, { filename: `inbox/${NAME}`, outcome: "declined", repo: "Acme/App", reason: "wrong-files", confidence: "High" }))
      .toBe(`Recorded: ${NAME} declined in acme/app (wrong-files). It doesn't count as an apply.`);
    expect(handoffs()).toEqual([row({ status: "declined", since: "2026-10-30" })]);
    expect(recordHandoffEvent).toHaveBeenCalledWith(1, `inbox/${NAME}`, "acme/app", "declined", { reason: "wrong-files", confidence: "high" });

    setup();
    await handleApplyCapture(user, { filename: NAME, outcome: "done", repo: "acme/app" });
    expect(handoffs()[0]!.status).toBe("done");
    expect(recordHandoffEvent).toHaveBeenLastCalledWith(1, `inbox/${NAME}`, "acme/app", "done", {});
  });

  // protects: the answer is kept in the capture with no free text; fails_when: no line is added, or the note lands in it; no_claim: none
  it("adds a line to the capture's Handoff log", async () => {
    setup();
    await handleApplyCapture(user, { filename: NAME, outcome: "declined", repo: "acme/app", reason: "doesnt-fit", applied_note: "a note" });
    const capture = files[`inbox/${NAME}`]!.content;
    expect(capture).toContain("\n## Handoff log\n- 2026-10-30 · acme/app · declined (doesnt-fit)\n\n## Links to memory");
    expect(capture).not.toContain("a note");
    expect(capture).toContain("status: inbox");
  });

  // protects: an unknown reason or confidence never reaches the counts as free text; fails_when: it's stored as given; no_claim: none
  it("keeps reason and confidence to their lists", async () => {
    setup();
    await handleApplyCapture(user, { filename: NAME, outcome: "declined", repo: "acme/app", reason: "the model was rude", confidence: "92%" });
    expect(recordHandoffEvent).toHaveBeenCalledWith(1, `inbox/${NAME}`, "acme/app", "declined", { reason: "other" });
    expect(files[`inbox/${NAME}`]!.content).toContain("- 2026-10-30 · acme/app · declined (other)\n");
  });

  // protects: a dead pair stays dead; fails_when: an answer revives it; no_claim: none
  it("leaves a dead row dead", async () => {
    setup([row({ status: "dead" })]);
    await handleApplyCapture(user, { filename: NAME, outcome: "later", repo: "acme/app" });
    expect(handoffs()[0]!.status).toBe("dead");
  });
});

describe("later", () => {
  // protects: AC9, "not now" snoozes 7 days, then the capture is offered again; fails_when: it's offered before the date or not on it; no_claim: none
  it("snoozes the row for 7 days", async () => {
    setup();
    expect(await handleApplyCapture(user, { filename: NAME, outcome: "later", repo: "acme/app" }))
      .toBe(`Snoozed: ${NAME} in acme/app until 2026-11-06. It doesn't count as an apply.`);
    const rows = handoffs();
    expect(rows[0]!.status).toBe("snoozed:2026-11-06");
    expect(offerable(rows, "acme/app", "2026-11-05")).toEqual([]);
    expect(offerable(rows, "acme/app", "2026-11-06")).toEqual(rows);
  });
});

describe("which handoff an answer is about", () => {
  // protects: an agent that leaves out repo still answers the one waiting handoff; fails_when: it's refused or lands elsewhere; no_claim: none
  it("uses the capture's only waiting row when repo is left out", async () => {
    setup([row(), row({ repo: "acme/web", status: "declined" })]);
    await handleApplyCapture(user, { filename: NAME, outcome: "later" });
    expect(handoffs().map((r) => r.status)).toEqual(["snoozed:2026-11-06", "declined"]);
    expect(recordHandoffEvent).toHaveBeenCalledWith(1, `inbox/${NAME}`, "acme/app", "later", {});
  });

  // protects: xkg never guesses between repos; fails_when: one of two waiting rows is changed, or anything is written; no_claim: none
  it("asks for repo when it can't tell, and records nothing", async () => {
    setup([row(), row({ repo: "acme/web" })]);
    const before = JSON.stringify(files);
    expect(await handleApplyCapture(user, { filename: NAME, outcome: "declined" }))
      .toBe("Pass repo (owner/name of the code repo) so xkg knows which handoff this answers. Nothing was recorded.");
    expect(JSON.stringify(files)).toBe(before);
    expect(recordHandoffEvent).not.toHaveBeenCalled();
  });

  // protects: an answer for a repo with no waiting row is still kept; fails_when: it's dropped or creates a row; no_claim: none
  it("records an answer for a repo with no row, without adding one", async () => {
    setup([]);
    await handleApplyCapture(user, { filename: NAME, outcome: "declined", repo: "acme/other", reason: "doesnt-fit" });
    expect(files["HANDOFFS.md"]).toBeUndefined();
    expect(files[`inbox/${NAME}`]!.content).toContain("- 2026-10-30 · acme/other · declined (doesnt-fit)\n");
    expect(recordHandoffEvent).toHaveBeenCalledWith(1, `inbox/${NAME}`, "acme/other", "declined", { reason: "doesnt-fit" });
  });

  // protects: a bad repo is named, never stored; fails_when: it's written; no_claim: none
  it("refuses a repo that isn't owner/name", async () => {
    setup();
    expect(await handleApplyCapture(user, { filename: NAME, outcome: "later", repo: "not a repo" })).toBe("repo must be owner/name, got: not a repo");
    expect(githubPut).not.toHaveBeenCalled();
  });
});

describe("arguments of the wrong type", () => {
  // protects: an agent that sends a number or an object never breaks the call; fails_when: it throws; no_claim: none
  it("are ignored or refused, never a crash", async () => {
    setup();
    await expect(handleApplyCapture(user, { filename: NAME, outcome: "declined", repo: "acme/app", reason: 3, confidence: {}, files: "src/llm.ts" } as never))
      .resolves.toBe(`Recorded: ${NAME} declined in acme/app (other). It doesn't count as an apply.`);
    await expect(handleApplyCapture(user, { filename: NAME, outcome: "later", repo: 42 } as never)).resolves.toBe("repo must be owner/name, got: 42");
    await expect(handleApplyCapture(user, { filename: NAME, commit_sha: SHA, outcome: 7, repo: ["x"] } as never)).resolves.toMatch(/^Applied: /);
  });
});

describe("no code reaches xkg", () => {
  // protects: AC1, a long note is cut to 200 characters and a field xkg doesn't know is ignored; fails_when: either is written anywhere; no_claim: what an agent puts in a short note
  it("caps the note and ignores unknown fields like spec", async () => {
    setup();
    const spec = `## Claim\n${"function secret() {}\n".repeat(250)}`;
    const note = "q".repeat(5000);
    await handleApplyCapture(user, { filename: NAME, commit_sha: SHA, repo: "acme/app", applied_note: note, spec } as never);
    await handleApplyCapture(user, { filename: NAME, outcome: "declined", repo: "acme/app", applied_note: note, spec } as never);
    expect(everything()).not.toContain("function secret");
    const longest = Math.max(...everything().match(/q+/g)!.map((m) => m.length));
    expect(longest).toBe(200);
  });
});

describe("applied", () => {
  // protects: AC11, a reported commit for a queued capture closes its handoff; fails_when: the row stays pending, the event or the log line is missing, or a file outside the map is kept; no_claim: the hook (git-hook tests)
  it("marks the row applied and logs the commit and the changed files", async () => {
    setup();
    const result = await handleApplyCapture(user, { filename: NAME, commit_sha: SHA, repo: "acme/app", files: ["src/llm.ts", "src/made-up.ts"], confidence: "medium" });
    expect(result).toBe(`Applied: ${NAME} → applied/${NAME} (a1b2c3d). The handoff in acme/app is done.`);
    expect(handoffs()).toEqual([row({ status: "applied", since: "2026-10-30" })]);
    expect(recordHandoffEvent).toHaveBeenCalledWith(1, `applied/${NAME}`, "acme/app", "applied", { confidence: "medium", withCommit: true });
    const capture = files[`applied/${NAME}`]!.content;
    expect(capture).toContain(`## Handoff log\n- 2026-10-30 · acme/app · applied · commit ${SHA} · confidence medium · files src/llm.ts\n`);
    expect(capture).toContain("## Application log");
    expect(recordApplyEvent).toHaveBeenCalledTimes(1);
  });

  // protects: applies outside a handoff work exactly as before; fails_when: a Handoff log or a HANDOFFS.md write appears; no_claim: none
  it("changes nothing else when no handoff waits", async () => {
    setup([row({ repo: "acme/web" })]);
    const before = files["HANDOFFS.md"]!.content;
    expect(await handleApplyCapture(user, { filename: NAME, commit_sha: SHA, repo: "acme/app" })).toBe(`Applied: ${NAME} → applied/${NAME} (a1b2c3d)`);
    expect(files["HANDOFFS.md"]!.content).toBe(before);
    expect(files[`applied/${NAME}`]!.content).not.toContain("Handoff log");
    expect(recordHandoffEvent).not.toHaveBeenCalled();
  });

  // protects: the hook's report closes the handoff even when the agent reported the commit first without repo; fails_when: "Already recorded" leaves the row pending; no_claim: none
  it("closes the handoff on a repeat report of the same commit", async () => {
    setup([row(), row({ repo: "acme/web" })]);
    await handleApplyCapture(user, { filename: NAME, commit_sha: SHA });
    expect(handoffs().map((r) => r.status)).toEqual(["pending", "pending"]);

    expect(await handleApplyCapture(user, { filename: NAME, commit_sha: SHA, repo: "acme/app", files: ["src/llm.ts"] }))
      .toBe(`Already recorded: ${NAME} (a1b2c3d). The handoff in acme/app is done.`);
    expect(handoffs().map((r) => r.status)).toEqual(["applied", "pending"]);
    expect(files[`applied/${NAME}`]!.content).toContain(`- 2026-10-30 · acme/app · applied · commit ${SHA} · files src/llm.ts\n`);
    expect(recordApplyEvent).toHaveBeenCalledTimes(2);

    // A third report changes nothing more
    await handleApplyCapture(user, { filename: NAME, commit_sha: SHA, repo: "acme/app" });
    expect(files[`applied/${NAME}`]!.content.match(/· applied ·/g)).toHaveLength(1);
  });

  // protects: older clients that describe what changed in outcome still record an apply; fails_when: free text is treated as an answer; no_claim: none
  it("treats any other outcome text as an apply, as before", async () => {
    setup([]);
    await handleApplyCapture(user, { filename: NAME, commit_sha: SHA, outcome: "Cut the error rate" });
    expect(files[`applied/${NAME}`]!.content).toContain("- **Outcome:** Cut the error rate");
    expect(recordApplyEvent).toHaveBeenCalledTimes(1);
  });
});

describe("reverted", () => {
  const LEDGER = `# Applied captures\n\n| Date | Capture | Commit | Target |\n| --- | --- | --- | --- |\n| 2026-10-29 | ${NAME} | ${SHA} | src/llm.ts |\n`;
  function appliedSetup() {
    setup([row({ status: "applied", since: "2026-10-29" })]);
    files[`applied/${NAME}`] = { content: CAPTURE.replace("status: inbox", "status: applied"), sha: "a1" };
    delete files[`inbox/${NAME}`];
    files["APPLIED.md"] = { content: LEDGER, sha: "l1" };
  }

  // protects: AC12's server side, a revert is kept without undoing the record; fails_when: the capture moves back, the ledger row goes, or the row reopens; no_claim: detecting the revert (git-hook tests)
  it("marks the ledger row, logs the revert, and leaves the row applied", async () => {
    appliedSetup();
    expect(await handleApplyCapture(user, { filename: NAME, outcome: "reverted", commit_sha: SHA, repo: "acme/app" }))
      .toBe(`Recorded: the apply of ${NAME} in commit a1b2c3d was reverted.`);
    expect(files["APPLIED.md"]!.content).toContain(`| 2026-10-29 | ${NAME} | ${SHA} | src/llm.ts · reverted 2026-10-30 |`);
    expect(files[`applied/${NAME}`]!.content).toContain(`## Handoff log\n- 2026-10-30 · acme/app · reverted · commit ${SHA}\n`);
    expect(files[`inbox/${NAME}`]).toBeUndefined();
    expect(handoffs()[0]!.status).toBe("applied");
    expect(recordHandoffEvent).toHaveBeenCalledWith(1, `applied/${NAME}`, "acme/app", "reverted", {});
    expect(recordApplyEvent).not.toHaveBeenCalled();
  });

  // protects: a revert of a capture never handed off is still kept; fails_when: it needs a repo; no_claim: none
  it("needs no repo", async () => {
    appliedSetup();
    delete files["HANDOFFS.md"];
    await handleApplyCapture(user, { filename: NAME, outcome: "reverted", commit_sha: SHA });
    expect(files[`applied/${NAME}`]!.content).toContain(`- 2026-10-30 · reverted · commit ${SHA}\n`);
    expect(recordHandoffEvent).not.toHaveBeenCalled();
  });

  // protects: a revert names its commit, and is kept once; fails_when: one without a sha is recorded, or a repeat adds a second line; no_claim: none
  it("needs the reverted commit, and records it once", async () => {
    appliedSetup();
    expect(await handleApplyCapture(user, { filename: NAME, outcome: "reverted" })).toBe("outcome reverted needs commit_sha: the sha of the commit that was reverted.");
    await handleApplyCapture(user, { filename: NAME, outcome: "reverted", commit_sha: SHA, repo: "acme/app" });
    expect(await handleApplyCapture(user, { filename: NAME, outcome: "reverted", commit_sha: SHA.slice(0, 7), repo: "acme/app" }))
      .toBe(`Already recorded: the revert of ${NAME} (a1b2c3d).`);
    expect(files[`applied/${NAME}`]!.content.match(/reverted/g)).toHaveLength(1);
    expect(recordHandoffEvent).toHaveBeenCalledTimes(1);
  });
});
