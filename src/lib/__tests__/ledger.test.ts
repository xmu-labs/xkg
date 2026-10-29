import { describe, it, expect } from "vitest";
import { appendLedgerRow, weeklyApplyStats, ledgerHasCommit, markReverted } from "../ledger";

/**
 * APPLIED.md is the apply metric's source of truth: one row per time a
 * capture was applied, with the commit when the agent reported one.
 */

const HEADER = "# Applied captures\n\nOne row per application. Written by xkg's apply_capture.\n\n| Date | Capture | Commit | Target |\n| --- | --- | --- | --- |\n";

describe("appendLedgerRow", () => {
  it("creates the ledger with a header when none exists", () => {
    const out = appendLedgerRow(null, { date: "2026-10-27", capture: "2026-10-01-x.md", commit: "a1b2c3d", target: "src/a.ts" });
    expect(out).toBe(`${HEADER}| 2026-10-27 | 2026-10-01-x.md | a1b2c3d | src/a.ts |\n`);
  });

  it("appends to an existing ledger and leaves earlier rows alone", () => {
    const existing = `${HEADER}| 2026-10-20 | 2026-10-01-a.md | 1111111 | src/a.ts |\n`;
    const out = appendLedgerRow(existing, { date: "2026-10-27", capture: "2026-10-02-b.md" });
    expect(out).toBe(`${existing}| 2026-10-27 | 2026-10-02-b.md | — | — |\n`);
  });

  it("escapes pipes and flattens newlines so a target can't break the table", () => {
    const out = appendLedgerRow(null, { date: "2026-10-27", capture: "c.md", target: "a|b\nc" });
    expect(out.trimEnd().split("\n").pop()).toBe("| 2026-10-27 | c.md | — | a\\|b c |");
  });

  it("escapes backslashes so an escaped pipe can't be faked", () => {
    const out = appendLedgerRow(null, { date: "2026-10-27", capture: "c.md", target: "a\\|b" });
    expect(out.trimEnd().split("\n").pop()).toBe("| 2026-10-27 | c.md | — | a\\\\\\|b |");
  });
});

describe("ledger round trip", () => {
  it("reads back a capture name containing pipes and backslashes exactly", () => {
    const name = "odd\\|name\\";
    const ledger = appendLedgerRow(null, { date: "2026-10-27", capture: name, commit: "a1b2c3d" });
    expect(ledgerHasCommit(ledger, name, "a1b2c3d")).toBe(true);
  });

  it("keeps columns apart when a value ends in a backslash", () => {
    const ledger = appendLedgerRow(null, { date: "2026-10-27", capture: "c\\", commit: "a1b2c3d", target: "dir\\" });
    expect(ledgerHasCommit(ledger, "c\\", "a1b2c3d")).toBe(true);
    expect(weeklyApplyStats(ledger, "2026-10-27", 1)).toEqual([{ weekStart: "2026-10-26", applied: 1, withCommit: 1 }]);
  });
});

describe("weeklyApplyStats", () => {
  const ledger =
    HEADER +
    "| 2026-10-27 | c1.md | a1b2c3d | src/a.ts |\n" + // week of Mon 2026-10-26
    "| 2026-10-26 | c2.md | — | — |\n" + // same week, no commit
    "| 2026-10-25 | c3.md | bbbbbbb | src/b.ts |\n" + // Sunday: week of Mon 2026-10-19
    "| 2026-09-01 | c4.md | ccccccc | src/c.ts |\n"; // outside the window

  it("counts applications and commits per Monday-start week, newest first, including empty weeks", () => {
    expect(weeklyApplyStats(ledger, "2026-10-27", 3)).toEqual([
      { weekStart: "2026-10-26", applied: 2, withCommit: 1 },
      { weekStart: "2026-10-19", applied: 1, withCommit: 1 },
      { weekStart: "2026-10-12", applied: 0, withCommit: 0 },
    ]);
  });

  it("returns zero weeks for a missing or empty ledger", () => {
    expect(weeklyApplyStats("", "2026-10-27", 2)).toEqual([
      { weekStart: "2026-10-26", applied: 0, withCommit: 0 },
      { weekStart: "2026-10-19", applied: 0, withCommit: 0 },
    ]);
  });
});

describe("ledgerHasCommit", () => {
  const ledger = HEADER + "| 2026-10-27 | c1.md | a1b2c3d4e5f6 | src/a.ts |\n| 2026-10-27 | c2.md | — | — |\n";

  it("matches the same capture and commit, whether either sha is short or full", () => {
    expect(ledgerHasCommit(ledger, "c1.md", "a1b2c3d")).toBe(true);
    expect(ledgerHasCommit(HEADER + "| 2026-10-27 | c1.md | a1b2c3d | — |\n", "c1.md", "a1b2c3d4e5f6")).toBe(true);
  });

  it("does not match another capture, another commit, or a row without a commit", () => {
    expect(ledgerHasCommit(ledger, "c2.md", "a1b2c3d")).toBe(false);
    expect(ledgerHasCommit(ledger, "c1.md", "bbbbbbb")).toBe(false);
  });
});

describe("markReverted", () => {
  const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
  const ledger =
    "# Applied captures\n\n| Date | Capture | Commit | Target |\n| --- | --- | --- | --- |\n" +
    `| 2026-10-20 | x.md | ${SHA} | src/a.ts |\n| 2026-10-21 | y.md | ${SHA} | — |\n| 2026-10-22 | x.md | 1111111 | — |\n`;

  // protects: a reverted apply stays in the ledger and says so; fails_when: another row is touched, the row is removed, or the week's count changes; no_claim: none
  it("marks the capture's row for that commit, short or full sha", () => {
    const next = markReverted(ledger, "x.md", SHA.slice(0, 7), "2026-10-30")!;
    expect(next).toContain(`| 2026-10-20 | x.md | ${SHA} | src/a.ts · reverted 2026-10-30 |\n`);
    expect(next).toContain(`| 2026-10-21 | y.md | ${SHA} | — |\n`);
    expect(next).toContain("| 2026-10-22 | x.md | 1111111 | — |\n");
    expect(weeklyApplyStats(next, "2026-10-22", 1)).toEqual(weeklyApplyStats(ledger, "2026-10-22", 1));
  });

  // protects: a repeated revert report changes nothing; fails_when: the mark is added twice, or a missing row is invented; no_claim: none
  it("returns null when there's nothing to mark", () => {
    const once = markReverted(ledger, "y.md", SHA, "2026-10-30")!;
    expect(once).toContain(`| 2026-10-21 | y.md | ${SHA} | reverted 2026-10-30 |\n`);
    expect(markReverted(once, "y.md", SHA, "2026-10-31")).toBeNull();
    expect(markReverted(ledger, "z.md", SHA, "2026-10-30")).toBeNull();
  });
});
