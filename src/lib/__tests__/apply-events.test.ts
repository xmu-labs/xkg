import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import crypto from "crypto";

/**
 * apply_events is the server's count of applied captures, so the apply metric
 * can be read for every user without reading their repos. It stores counts
 * only: a keyed hash of the capture, a short commit id, the agent and whether
 * a reason was given. The capture's name and the reason stay in the user's repo.
 */

const queries: Array<{ text: string; values: unknown[] }> = [];
let rows: unknown[] = [];

vi.mock("../sql", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join("?").replace(/\s+/g, " ").trim(), values });
    return Promise.resolve({ rows, rowCount: rows.length });
  },
}));

beforeAll(() => {
  process.env.SESSION_SECRET = "test-secret-for-apply-events";
});

const { captureKey, commitKey, recordApplyEvent, applyGateStats } = await import("../apply-events");

beforeEach(() => {
  queries.length = 0;
  rows = [];
});

describe("captureKey", () => {
  it("is the same for a capture in the inbox and after it moved to applied/", () => {
    expect(captureKey("inbox/2026-01-01-idea.md")).toBe(captureKey("2026-01-01-idea.md"));
    expect(captureKey("applied/2026-01-01-idea.md")).toBe(captureKey("2026-01-01-idea.md"));
  });

  it("differs between captures", () => {
    expect(captureKey("2026-01-01-a.md")).not.toBe(captureKey("2026-01-01-b.md"));
  });

  it("can't be recomputed from a guessed filename without the server secret", () => {
    const plain = crypto.createHash("sha256").update("2026-01-01-idea.md").digest("hex");
    expect(plain.startsWith(captureKey("2026-01-01-idea.md"))).toBe(false);
    expect(captureKey("2026-01-01-idea.md")).not.toContain("idea");
  });
});

describe("commitKey", () => {
  it("stores a short and a full sha of the same commit the same way", () => {
    expect(commitKey("A1B2C3D")).toBe("a1b2c3d");
    expect(commitKey("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678")).toBe("a1b2c3d");
  });

  it("is null when there is no commit", () => {
    expect(commitKey(undefined)).toBeNull();
    expect(commitKey("")).toBeNull();
  });
});

describe("recordApplyEvent", () => {
  it("inserts one row and ignores a duplicate of the same capture and commit", async () => {
    await recordApplyEvent({ userId: 7, filename: "inbox/2026-01-01-idea.md", commit: "a1b2c3d4e5f6", harness: "codex", hasWhy: true });

    expect(queries).toHaveLength(1);
    expect(queries[0]!.text).toMatch(/^INSERT INTO apply_events .* ON CONFLICT DO NOTHING$/);
    expect(queries[0]!.values).toEqual([7, captureKey("2026-01-01-idea.md"), "a1b2c3d", "codex", true]);
  });

  it("stores no capture name or reason text", async () => {
    await recordApplyEvent({ userId: 7, filename: "2026-01-01-secret-plan.md", commit: undefined, harness: "unknown", hasWhy: false });
    const stored = JSON.stringify(queries[0]!.values);
    expect(stored).not.toContain("secret-plan");
  });

  it("caps the harness name so a client can't store arbitrary text", async () => {
    await recordApplyEvent({ userId: 7, filename: "a.md", commit: undefined, harness: "x".repeat(500), hasWhy: false });
    expect((queries[0]!.values[3] as string).length).toBeLessThanOrEqual(64);
  });
});

describe("applyGateStats", () => {
  it("counts distinct captures per user and week, so one capture in 3 commits counts once", async () => {
    const key = captureKey("2026-01-01-idea.md");
    rows = [
      { user_id: 7, capture_key: key, commit7: "aaaaaaa", harness: "claude-code", has_why: true, applied_at: "2026-10-27T10:00:00Z" },
      { user_id: 7, capture_key: key, commit7: "bbbbbbb", harness: "claude-code", has_why: true, applied_at: "2026-10-28T10:00:00Z" },
      { user_id: 7, capture_key: key, commit7: "ccccccc", harness: "codex", has_why: false, applied_at: "2026-10-29T10:00:00Z" },
      { user_id: 7, capture_key: captureKey("2026-01-01-other.md"), commit7: null, harness: "unknown", has_why: false, applied_at: "2026-10-29T11:00:00Z" },
    ];

    const stats = await applyGateStats("2026-10-29", 1);

    expect(stats).toEqual([
      {
        userId: 7,
        weekStart: "2026-10-26",
        captures: 2,
        capturesWithCommit: 1,
        capturesWithWhy: 1,
        harnesses: { "claude-code": 1, codex: 1, unknown: 1 },
      },
    ]);
  });

  it("only reads the requested weeks", async () => {
    await applyGateStats("2026-10-29", 2);
    expect(queries[0]!.text).toMatch(/WHERE applied_at >= \?/);
    expect(queries[0]!.values).toEqual(["2026-10-19"]);
  });
});
