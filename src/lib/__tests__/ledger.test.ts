import { describe, it, expect } from "vitest";
import { appendLedgerRow, weeklyApplyStats, ledgerHasCommit } from "../ledger";

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
