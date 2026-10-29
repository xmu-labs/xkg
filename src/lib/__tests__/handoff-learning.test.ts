import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import type { HandoffLogEntry, HandoffRow } from "../handoffs";

/**
 * Learning from handoff answers, with no model: each capture's Handoff log
 * becomes signals per capture × file and capture × repo, weighed with a
 * 30-day half-life. Two negatives make a dead end; files applied for two
 * captures that share a tag are "proven" for that tag. The index is kept in
 * handoff_scores and can be rebuilt from git.
 */

const queries: Array<{ text: string; values: unknown[] }> = [];
let selectRows: unknown[] = [];
let fail = false;

vi.mock("../sql", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    queries.push({ text, values });
    if (fail) return Promise.reject(new Error("db down"));
    return Promise.resolve({ rows: text.startsWith("SELECT") ? selectRows : [], rowCount: 0 });
  },
}));

const files: Record<string, { content: string; sha: string }> = {};
/** GitHub answers for a path that isn't a 200 or a 404 (a rate limit, an expired token). */
const failing: Record<string, number> = {};
vi.mock("../github", () => ({
  readFile: async (_t: string, _r: string, path: string) => files[path] ?? null,
  githubGet: async (_t: string, _r: string, path: string) => {
    if (failing[path]) return { ok: false, data: { message: "rate limited" }, status: failing[path] };
    const f = files[path];
    return f ? { ok: true, data: { content: Buffer.from(f.content).toString("base64"), sha: f.sha }, status: 200 } : { ok: false, data: null, status: 404 };
  },
  githubPut: vi.fn(async (_t: string, _r: string, path: string, content: string) => {
    files[path] = { content, sha: `${path}-${Object.keys(files).length}` };
  }),
}));

beforeAll(() => {
  process.env.SESSION_SECRET = "test-secret-for-handoff-learning";
});

const { decayed, scoresOf, provenFiles, tagKey, learnFrom, forgetCapture, deadEnds, provenFor, rebuildHandoffIndex, HALF_LIFE_DAYS } = await import("../handoff-learning");
const { captureKey } = await import("../apply-events");
const { appendHandoffLog, handoffLogLine, renderHandoffs, parseHandoffs } = await import("../handoffs");

const TODAY = "2026-12-01";
const e = (over: Partial<HandoffLogEntry> & Pick<HandoffLogEntry, "outcome">): HandoffLogEntry => ({ date: TODAY, repo: "acme/app", ...over });
const byKey = (scores: { repo: string; path: string; weight: number; negatives: number }[]) =>
  Object.fromEntries(scores.map((s) => [`${s.repo} ${s.path || "(repo)"}`, { weight: Number(s.weight.toFixed(4)), negatives: s.negatives }]));

beforeEach(() => {
  queries.length = 0;
  selectRows = [];
  fail = false;
  for (const k of Object.keys(files)) delete files[k];
  for (const k of Object.keys(failing)) delete failing[k];
});

describe("decay", () => {
  // protects: spec AC15, old answers count less; fails_when: the half-life isn't 30 days; no_claim: none
  it("halves a signal every 30 days: a +1 from 60 days ago weighs 0.25", () => {
    expect(HALF_LIFE_DAYS).toBe(30);
    expect(decayed(1, "2026-10-02", TODAY)).toBeCloseTo(0.25, 2);
    expect(decayed(-2, TODAY, TODAY)).toBe(-2);
  });
});

describe("scoresOf", () => {
  // protects: an apply rewards the files it changed and its repo, once per commit; fails_when: a repeat report of the same commit counts twice; no_claim: none
  it("gives an apply +1 per changed file and +1 to the repo, once per commit", () => {
    const apply = e({ outcome: "applied", commit: "a".repeat(40), files: ["src/a.ts", "src/b.ts"] });
    expect(byKey(scoresOf([apply, { ...apply, date: "2026-12-01", commit: "aaaaaaa" }], TODAY))).toEqual({
      "acme/app (repo)": { weight: 1, negatives: 0 },
      "acme/app src/a.ts": { weight: 1, negatives: 0 },
      "acme/app src/b.ts": { weight: 1, negatives: 0 },
    });
  });

  // protects: the two decline reasons teach different things; fails_when: wrong-files marks the repo, or doesnt-fit marks files; no_claim: none
  it("counts wrong-files against the suggested files and doesnt-fit against the repo", () => {
    expect(byKey(scoresOf([
      e({ outcome: "declined", reason: "wrong-files", files: ["src/a.ts"] }),
      e({ outcome: "declined", reason: "doesnt-fit", repo: "acme/web", files: ["src/x.ts"] }),
      e({ outcome: "declined", reason: "other", files: ["src/o.ts"] }),
    ], TODAY))).toEqual({
      "acme/app src/a.ts": { weight: -1, negatives: 1 },
      "acme/web (repo)": { weight: -1, negatives: 1 },
    });
  });

  // protects: a revert reported for one repo takes back that repo's apply only; fails_when: an apply of the same commit in another repo (a fork) is cancelled instead; no_claim: none
  it("matches a revert to the apply in the repo it names", () => {
    const sha = "d".repeat(40);
    const scores = scoresOf([
      e({ outcome: "applied", commit: sha, files: ["src/a.ts"] }),
      e({ outcome: "applied", repo: "acme/fork", commit: sha, files: ["src/a.ts"] }),
      { date: TODAY, repo: "acme/fork", outcome: "reverted", commit: sha },
    ], TODAY);
    expect(byKey(scores)).toEqual({
      "acme/app (repo)": { weight: 1, negatives: 0 },
      "acme/app src/a.ts": { weight: 1, negatives: 0 },
      "acme/fork (repo)": { weight: -1, negatives: 1 },
      "acme/fork src/a.ts": { weight: -1, negatives: 1 },
    });
  });

  // protects: a revert takes back the apply and counts against it; fails_when: the +1 stays, or a revert with no repo is lost; no_claim: none
  it("cancels a reverted apply and counts -1 per file and for the repo", () => {
    const scores = scoresOf([
      e({ outcome: "applied", date: "2026-11-01", commit: "c".repeat(40), files: ["src/a.ts"] }),
      { date: TODAY, outcome: "reverted", commit: "ccccccc" },
    ], TODAY);
    expect(byKey(scores)).toEqual({
      "acme/app (repo)": { weight: -1, negatives: 1 },
      "acme/app src/a.ts": { weight: -1, negatives: 1 },
    });
  });

  // protects: a revert's own files count when its apply named none, or wasn't logged; fails_when: the reverted files never get a negative, so they can't become dead ends; no_claim: none
  it("counts the revert's files when the apply named none", () => {
    const scores = scoresOf([
      e({ outcome: "applied", date: "2026-11-01", commit: "c".repeat(40) }),
      e({ outcome: "reverted", commit: "ccccccc", files: ["src/a.ts"] }),
      e({ outcome: "reverted", commit: "d".repeat(7), files: ["src/b.ts"] }),
    ], TODAY);
    expect(byKey(scores)).toEqual({
      "acme/app (repo)": { weight: -2, negatives: 2 },
      "acme/app src/a.ts": { weight: -1, negatives: 1 },
      "acme/app src/b.ts": { weight: -1, negatives: 1 },
    });
  });

  // protects: answers that aren't about fit don't move anything; fails_when: later, done, expired or a repeated line changes a score; no_claim: none
  it("ignores later, done and expired, and a line repeated the same day", () => {
    const decline = e({ outcome: "declined", reason: "wrong-files", files: ["src/a.ts"] });
    expect(scoresOf([e({ outcome: "later" }), e({ outcome: "done" }), e({ outcome: "expired" })], TODAY)).toEqual([]);
    expect(byKey(scoresOf([decline, decline], TODAY))["acme/app src/a.ts"]).toEqual({ weight: -1, negatives: 1 });
    expect(byKey(scoresOf([decline, { ...decline, date: "2026-11-30" }], TODAY))["acme/app src/a.ts"]!.negatives).toBe(2);
  });
});

describe("provenFiles", () => {
  const rowOf = (capture: string, path: string, weight: number, tags = ["llm"], updatedAt = TODAY, negatives = 0) => ({
    captureKey: capture, tagKeys: tags.map(tagKey), repo: "acme/app", path, weight, negatives, updatedAt,
  });

  // protects: spec AC14, a file applied for two captures with a shared tag is proven for that tag; fails_when: one capture is enough, or a stale or other-tag file counts; no_claim: Jev's pool (where tests)
  it("proves a file applied for 2 captures that share a tag, with weight over 0.5", () => {
    expect(provenFiles([rowOf("c1", "src/a.ts", 1), rowOf("c2", "src/a.ts", 1)], [tagKey("llm")], TODAY))
      .toEqual([{ tagKey: tagKey("llm"), repo: "acme/app", path: "src/a.ts", captures: 2, weight: 2 }]);
    expect(provenFiles([rowOf("c1", "src/a.ts", 1)], [tagKey("llm")], TODAY)).toEqual([]);
    expect(provenFiles([rowOf("c1", "src/a.ts", 1, ["llm"], "2026-08-03"), rowOf("c2", "src/a.ts", 1, ["llm"], "2026-08-03")], [tagKey("llm")], TODAY)).toEqual([]);
    expect(provenFiles([rowOf("c1", "src/a.ts", 1, ["css"]), rowOf("c2", "src/a.ts", 1, ["css"])], [tagKey("llm")], TODAY)).toEqual([]);
  });

  // protects: a capture whose file became a dead end doesn't vouch for it; fails_when: its old +1 still counts; no_claim: none
  it("leaves out a capture for which the file is a dead end", () => {
    expect(provenFiles([rowOf("c1", "src/a.ts", 1), rowOf("c2", "src/a.ts", 1, ["llm"], TODAY, 2)], [tagKey("llm")], TODAY)).toEqual([]);
  });
});

const NAME = "2026-11-01-llm-memory.md";
const capture = (log: HandoffLogEntry[], tags = "llm, memory") =>
  log.reduce((c, entry) => appendHandoffLog(c, handoffLogLine(entry)), `---\ntags: ${tags}\nstatus: applied\n---\n\n# LLM Memory\n\n## Core idea\nIdea.\n`);
const user = { id: 7, github_token: "t", github_repo: "me/knowledge" };
/** The statements that write scores. */
const inserts = () => queries.filter((q) => q.text.startsWith("WITH caps AS"));
/** The captures a write replaces, with the size of the log each came from. */
const capsOf = (q: { values: unknown[] }) => {
  const [keys, entries] = q.values as [string[], number[]];
  return keys.map((key, i) => ({ key, entries: entries[i] }));
};
/** The rows a write installs. */
const rowsOf = (q: { values: unknown[] }) => {
  const [capKeys, capEntries, keys, repos, paths, weights, negatives, tags] = q.values as [string[], number[], string[], string[], string[], number[], number[], string[]];
  return keys.map((key, i) => ({
    key, repo: repos[i], path: paths[i], weight: weights[i], negatives: negatives[i],
    tagKeys: tags[i]!.split(",").filter(Boolean), entries: capEntries[capKeys.indexOf(key)],
  }));
};

describe("learnFrom", () => {
  // protects: each answer updates the capture's rows, keyed and tagged by hash only; fails_when: the capture's name or a tag is stored, or old rows stay; no_claim: none
  it("replaces the capture's rows with scores from its log", async () => {
    await learnFrom(user, `applied/${NAME}`, capture([e({ outcome: "applied", commit: "a".repeat(7), files: ["src/a.ts"] })]), TODAY);
    expect(inserts()).toHaveLength(1);
    const q = inserts()[0]!;
    const tagKeys = [tagKey("llm"), tagKey("memory")];
    expect(capsOf(q)).toEqual([{ key: captureKey(NAME), entries: 1 }]);
    expect(rowsOf(q)).toEqual([
      { key: captureKey(NAME), repo: "acme/app", path: "", weight: 1, negatives: 0, tagKeys, entries: 1 },
      { key: captureKey(NAME), repo: "acme/app", path: "src/a.ts", weight: 1, negatives: 0, tagKeys, entries: 1 },
    ]);
    expect(q.values).toContain(7);
    expect(q.values).toContain(TODAY);
    expect(JSON.stringify(q.values)).not.toMatch(/llm-memory|"llm"|"memory"/);
  });

  // protects: two answers for one capture landing together never leave the older learning, and a failed write never drops the rows; fails_when: the old rows are deleted in a separate statement, or a write from a shorter log can replace one from a longer log; no_claim: Postgres row locking itself (checked against a real database in QA)
  it("replaces the rows in one statement that never overwrites a longer log", async () => {
    const log = [e({ outcome: "applied", commit: "a".repeat(7), files: ["src/a.ts"] }), e({ outcome: "declined", reason: "wrong-files", files: ["src/b.ts"] })];
    await learnFrom(user, `inbox/${NAME}`, capture(log), TODAY);
    const writes = queries.filter((q) => /^(WITH|INSERT|DELETE|UPDATE)/.test(q.text));
    expect(writes).toHaveLength(1);
    const { text } = writes[0]!;
    expect(capsOf(writes[0]!)).toEqual([{ key: captureKey(NAME), entries: 2 }]);
    // Rows the new snapshot no longer has go in the same statement, and only from a log no longer than this one
    expect(text).toMatch(/DELETE FROM handoff_scores s USING caps c WHERE s\.user_id = \? AND s\.capture_key = c\.k AND s\.log_entries <= c\.e/);
    // Rows it has are upserted, never over a longer log
    expect(text).toMatch(/ON CONFLICT \(user_id, capture_key, repo, path\) DO UPDATE SET .* WHERE handoff_scores\.log_entries <= EXCLUDED\.log_entries$/);
    expect(text).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM handoff_scores s WHERE s\.user_id = \? AND s\.capture_key = i\.k AND s\.log_entries > c\.e\)/);
  });

  // protects: spec rule 1, a capture turned down twice in a repo is never offered there again; fails_when: the row stays declined; no_claim: none
  it("marks the HANDOFFS.md row dead after 2 negatives for the repo", async () => {
    const row: HandoffRow = { capture: `inbox/${NAME}`, repo: "acme/app", kind: "code", files: [], fit: "strong", status: "declined", since: TODAY, source: "auto" };
    files["HANDOFFS.md"] = { content: renderHandoffs([row]), sha: "h1" };
    const no = (date: string) => e({ outcome: "declined", reason: "doesnt-fit", date });
    await learnFrom(user, `inbox/${NAME}`, capture([no("2026-11-20")]), TODAY);
    expect(parseHandoffs(files["HANDOFFS.md"].content).rows[0]!.status).toBe("declined");
    await learnFrom(user, `inbox/${NAME}`, capture([no("2026-11-20"), no(TODAY)]), TODAY);
    expect(parseHandoffs(files["HANDOFFS.md"].content).rows[0]!.status).toBe("dead");
  });

  // protects: learning never breaks an answer; fails_when: a database error escapes; no_claim: none
  it("never throws, and reads fall back to nothing learned", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    fail = true;
    await expect(learnFrom(user, `inbox/${NAME}`, capture([e({ outcome: "declined", reason: "doesnt-fit" })]), TODAY)).resolves.toBeUndefined();
    expect(await deadEnds(7, `inbox/${NAME}`, "acme/app")).toEqual(new Set());
    expect(await provenFor(7, ["llm"], TODAY)).toEqual([]);
    spy.mockRestore();
  });
});

describe("forgetCapture", () => {
  // protects: a deleted capture's learning goes with it, so a new capture with the same name starts fresh; fails_when: its rows stay, or another capture's go; no_claim: none
  it("deletes the capture's rows only", async () => {
    await forgetCapture(7, `inbox/${NAME}`);
    const del = queries.find((q) => q.text.startsWith("DELETE FROM handoff_scores"))!;
    expect(del.text).toBe("DELETE FROM handoff_scores WHERE user_id = ? AND capture_key = ?");
    expect(del.values).toEqual([7, captureKey(NAME)]);
  });

  // protects: deleting a capture never fails on the index; fails_when: a database error escapes; no_claim: none
  it("never throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    fail = true;
    await expect(forgetCapture(7, NAME)).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

describe("reads", () => {
  // protects: spec AC13 input, the paths that became dead ends for a capture in a repo; fails_when: another capture's or repo's rows are read; no_claim: none
  it("deadEnds reads the capture's files with 2 negatives in that repo", async () => {
    selectRows = [{ path: "src/a.ts" }];
    expect(await deadEnds(7, `inbox/${NAME}`, "Acme/App")).toEqual(new Set(["src/a.ts"]));
    const q = queries.find((x) => x.text.startsWith("SELECT"))!;
    expect(q.values).toEqual([7, captureKey(NAME), "acme/app", 2]);
  });

  // protects: a new capture's tags find proven files, named by the capture's own tag; fails_when: the tag is sent or returned as a hash; no_claim: none
  it("provenFor returns proven files with the capture's tag", async () => {
    selectRows = [
      { capture_key: "c1", tag_keys: [tagKey("llm")], repo: "acme/app", path: "src/a.ts", weight: 1, negatives: 0, updated_at: TODAY },
      { capture_key: "c2", tag_keys: [tagKey("llm"), tagKey("css")], repo: "acme/app", path: "src/a.ts", weight: 1, negatives: 0, updated_at: TODAY },
    ];
    expect(await provenFor(7, ["LLM", "rag"], TODAY)).toEqual([{ tag: "LLM", repo: "acme/app", path: "src/a.ts", captures: 2, weight: 2 }]);
    const q = queries.find((x) => x.text.startsWith("SELECT"))!;
    expect(q.values).toEqual([7, [tagKey("llm"), tagKey("rag")]]);
  });
});

describe("rebuildHandoffIndex", () => {
  // protects: spec AC16, the index is only a cache of git; fails_when: rebuilding gives different rows than learning answer by answer; no_claim: none
  it("rebuilds the same rows from HANDOFFS.md and the captures' logs", async () => {
    const logA = [e({ outcome: "applied", commit: "a".repeat(7), files: ["src/a.ts"] })];
    const logB = [e({ outcome: "declined", reason: "wrong-files", files: ["src/b.ts"] })];
    const rowFor = (capture: string): HandoffRow => ({ capture, repo: "acme/app", kind: "code", files: [], fit: "strong", status: "applied", since: TODAY, source: "auto" });
    files["HANDOFFS.md"] = { content: renderHandoffs([rowFor(`inbox/${NAME}`), rowFor("inbox/b.md"), rowFor("inbox/gone.md")]), sha: "h1" };
    files[`applied/${NAME}`] = { content: capture(logA), sha: "a1" };
    files["inbox/b.md"] = { content: capture(logB, "css"), sha: "b1" };

    await learnFrom(user, `applied/${NAME}`, capture(logA), TODAY);
    await learnFrom(user, "inbox/b.md", capture(logB, "css"), TODAY);
    const learned = inserts().flatMap(rowsOf);
    queries.length = 0;

    expect(await rebuildHandoffIndex(user, TODAY)).toEqual({ captures: 2, rows: 3 });
    expect(inserts().flatMap(rowsOf)).toEqual(learned);
  });

  // protects: a rebuild is installed all at once and never discards answers learned while it ran; fails_when: it wipes the user's rows, writes in more than one statement, or replaces rows from a longer log; no_claim: Postgres row locking itself (checked against a real database in QA)
  it("replaces the captures it read in one statement, keeping newer answers and other captures", async () => {
    const rowFor = (capture: string): HandoffRow => ({ capture, repo: "acme/app", kind: "code", files: [], fit: "strong", status: "applied", since: TODAY, source: "auto" });
    files["HANDOFFS.md"] = { content: renderHandoffs([rowFor(`inbox/${NAME}`), rowFor("inbox/b.md")]), sha: "h1" };
    files[`inbox/${NAME}`] = { content: capture([e({ outcome: "applied", commit: "a".repeat(7), files: ["src/a.ts"] })]), sha: "a1" };
    files["inbox/b.md"] = { content: capture([e({ outcome: "later" })], "css"), sha: "b1" };

    await rebuildHandoffIndex(user, TODAY);
    const writes = queries.filter((q) => /^(WITH|INSERT|DELETE|UPDATE)/.test(q.text));
    expect(writes).toHaveLength(1);
    // A capture with nothing to learn is still replaced, so its old rows go
    expect(capsOf(writes[0]!)).toEqual([{ key: captureKey(NAME), entries: 1 }, { key: captureKey("b.md"), entries: 1 }]);
    expect(writes[0]!.text).toMatch(/DELETE FROM handoff_scores s USING caps c WHERE s\.user_id = \? AND s\.capture_key = c\.k AND s\.log_entries <= c\.e/);
    expect(writes[0]!.text).toMatch(/WHERE handoff_scores\.log_entries <= EXCLUDED\.log_entries$/);
  });

  // protects: a failed GitHub read never wipes what was learned; fails_when: an error reading HANDOFFS.md or a capture deletes the index or reports success; no_claim: none
  it("keeps the index when GitHub can't be read", async () => {
    const rowFor = (capture: string): HandoffRow => ({ capture, repo: "acme/app", kind: "code", files: [], fit: "strong", status: "applied", since: TODAY, source: "auto" });
    files["HANDOFFS.md"] = { content: renderHandoffs([rowFor(`inbox/${NAME}`)]), sha: "h1" };
    files[`inbox/${NAME}`] = { content: capture([e({ outcome: "applied", files: ["src/a.ts"] })]), sha: "a1" };
    for (const path of ["HANDOFFS.md", `inbox/${NAME}`]) {
      failing[path] = 403;
      queries.length = 0;
      await expect(rebuildHandoffIndex(user, TODAY)).rejects.toThrow(/HTTP 403/);
      expect(queries.some((q) => /^(WITH|INSERT|DELETE|UPDATE)/.test(q.text))).toBe(false);
      delete failing[path];
    }
  });
});
