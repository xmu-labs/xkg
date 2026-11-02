import { describe, it, expect, vi, beforeEach } from "vitest";

/** saveNewCapture never overwrites: a taken name gets -2, -3, … (XKG-139). */

const taken = new Set<string>();
const githubPut = vi.fn(async (_t: string, _r: string, path: string) => {
  if (taken.has(path)) throw Object.assign(new Error("HTTP 422"), { status: 422, fileExists: true });
  taken.add(path);
});
vi.mock("@/lib/github", () => ({ githubPut: (...a: [string, string, string]) => githubPut(...a) }));

const { saveNewCapture, MAX_NAME_TRIES } = await import("../capture-file");

beforeEach(() => { taken.clear(); githubPut.mockClear(); });

describe("saveNewCapture", () => {
  // protects: the usual case is unchanged; fails_when: a free name gets a suffix; no_claim: none
  it("keeps the name when it is free", async () => {
    expect(await saveNewCapture("t", "o/r", "2026-11-02-a", "x")).toBe("2026-11-02-a.md");
    expect(githubPut).toHaveBeenCalledWith("t", "o/r", "inbox/2026-11-02-a.md", "x", "capture: add 2026-11-02-a.md");
  });

  // protects: clashes count up; fails_when: -2 is skipped or reused; no_claim: none
  it("counts up past taken names", async () => {
    taken.add("inbox/2026-11-02-a.md");
    taken.add("inbox/2026-11-02-a-2.md");
    expect(await saveNewCapture("t", "o/r", "2026-11-02-a", "x")).toBe("2026-11-02-a-3.md");
  });

  // protects: other errors are not retried; fails_when: a 502 is retried under another name; no_claim: none
  it("throws other errors at once", async () => {
    githubPut.mockRejectedValueOnce(Object.assign(new Error("HTTP 502"), { status: 502, fileExists: false }));
    await expect(saveNewCapture("t", "o/r", "2026-11-02-a", "x")).rejects.toThrow("HTTP 502");
    expect(githubPut).toHaveBeenCalledTimes(1);
  });

  // protects: the loop is bounded; fails_when: it tries forever; no_claim: none
  it("gives up after a bounded number of tries", async () => {
    taken.add("inbox/2026-11-02-a.md");
    for (let i = 2; i <= MAX_NAME_TRIES; i++) taken.add(`inbox/2026-11-02-a-${i}.md`);
    await expect(saveNewCapture("t", "o/r", "2026-11-02-a", "x")).rejects.toThrow();
    expect(githubPut).toHaveBeenCalledTimes(MAX_NAME_TRIES);
  });
});
