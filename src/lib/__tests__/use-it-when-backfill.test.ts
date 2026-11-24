import { describe, it, expect, vi, beforeEach } from "vitest";
import type { User } from "../db";

/**
 * Backfill: captures saved before the "Use it when" line existed get one,
 * written by the user's own model, a page at a time. A rerun skips files
 * that already have a line, and the estimate comes before any model call.
 *
 * Fixtures are synthetic: never copy real captures into this public repo.
 */

const files = new Map<string, string>();
const puts: Array<{ path: string; content: string; sha?: string }> = [];
let modelAnswer: unknown = { use_it_when: "Use it when shared work keeps getting dropped because nobody is responsible for it." };
let modelCalls = 0;
/** When set, the provider answers with this HTTP error instead of a line. */
let modelError: { status: number; body: string } | null = null;
let lastPrompt = "";
/** Writes running at once, and the most seen: GitHub rejects overlapping writes to one branch. */
let inFlight = 0;
let maxInFlight = 0;
/** Paths that vanish between the listing and the read, as when a capture moves. */
const vanish = new Set<string>();
/** Answers GitHub gives the next writes, in order; empty means the write lands. */
const putErrors: Array<{ status: number; message: string; retryAfter?: number } | null> = [];

vi.mock("../github", () => ({
  githubGet: async (_t: string, _r: string, dir: string) => {
    const names = [...files.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => ({ name: p.slice(dir.length + 1) }));
    return names.length ? { ok: true, status: 200, data: names } : { ok: false, status: 404, data: null };
  },
  readFileStrict: async (_t: string, _r: string, path: string) => (files.has(path) && !vanish.has(path) ? { content: files.get(path)!, sha: `sha-${path}` } : null),
  githubPut: async (_t: string, _r: string, path: string, content: string, _m: string, sha?: string) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    // GitHub answers a write some time later; overlapping writes on one branch conflict.
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    const refused = putErrors.shift();
    if (refused) throw Object.assign(new Error(`GitHub PUT ${path}: HTTP ${refused.status} — ${refused.message}`), { status: refused.status, retryAfter: refused.retryAfter });
    puts.push({ path, content, sha });
    files.set(path, content);
  },
}));
vi.mock("../llm-spend", () => ({ recordSpend: async () => {} }));

vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
  if (new URL(String(url)).hostname !== "api.openai.com") throw new Error(`unexpected fetch ${url}`);
  modelCalls++;
  lastPrompt = JSON.stringify(JSON.parse(init.body).messages);
  if (modelError) return new Response(modelError.body, { status: modelError.status });
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(modelAnswer) } }], usage: { prompt_tokens: 900, completion_tokens: 30 } }), { status: 200 });
});

const { addUseItWhen, backfillPage, backfillEstimate, pacing, GitHubWriteLimitError } = await import("../use-it-when-backfill");
/** Gaps the backfill waited between writes; none are really waited in tests. */
const gaps: number[] = [];
vi.spyOn(pacing, "pause").mockImplementation(async (ms: number) => { gaps.push(ms); });
const user = { id: 7, llm_api_key: "k", github_token: "t", github_repo: "o/r", llm_provider: "openai", llm_model: null, llm_effort: null } as unknown as User;

function capture(title: string, extra = ""): string {
  return `---\ndate: 2026-10-01\nsource: ${title}\ntype: notes\nstatus: inbox\nlowConfidence: false\n${extra}source_sha256: abc\n---\n\n# ${title}\n\n## Core idea\nEvery alert needs one named owner.\n\n## Key takeaways\n- A channel is not an owner.\n\n## Links to memory\n_none yet_\n\n---\n\n<details>\n<summary>Raw capture</summary>\n\nSECRET RAW TEXT\n\n</details>\n`;
}

beforeEach(() => {
  files.clear();
  vanish.clear();
  putErrors.length = 0;
  gaps.length = 0;
  puts.length = 0;
  inFlight = 0;
  maxInFlight = 0;
  modelCalls = 0;
  modelError = null;
  modelAnswer = { use_it_when: "Use it when shared work keeps getting dropped because nobody is responsible for it." };
});

describe("addUseItWhen", () => {
  it("puts the line right after lowConfidence in the frontmatter", () => {
    const out = addUseItWhen(capture("A"), "Use it when x happens.");
    expect(out).toContain("lowConfidence: false\nuse_it_when: Use it when x happens.\nsource_sha256: abc\n---");
  });

  it("puts it before the closing line when there is no lowConfidence", () => {
    const out = addUseItWhen("---\ndate: 2026-01-01\n---\n\n# T\n", "Use it when x happens.");
    expect(out).toBe("---\ndate: 2026-01-01\nuse_it_when: Use it when x happens.\n---\n\n# T\n");
  });

  it("leaves a file alone when it already has a line, or has no frontmatter", () => {
    const has = capture("A", "use_it_when: Use it when y.\n");
    expect(addUseItWhen(has, "Use it when x happens.")).toBe(has);
    expect(addUseItWhen("# No frontmatter\n", "Use it when x happens.")).toBe("# No frontmatter\n");
  });

  it("never touches a lowConfidence line below the frontmatter", () => {
    const out = addUseItWhen(capture("A").replace("SECRET RAW TEXT", "lowConfidence: false"), "Use it when x happens.");
    expect(out.match(/use_it_when:/g)).toHaveLength(1);
    expect(out.indexOf("use_it_when:")).toBeLessThan(out.indexOf("\n---\n\n#"));
  });
});

describe("backfillPage", () => {
  it("stops with the provider's reason when the key is refused, so the card can say what to fix", async () => {
    files.set("inbox/2026-10-01-a.md", capture("A"));
    files.set("inbox/2026-10-02-b.md", capture("B"));
    modelError = { status: 401, body: '{"error":{"code":"invalid_api_key"}}' };
    await expect(backfillPage(user, { limit: 5 })).rejects.toThrow(/HTTP 401/);
    expect(puts).toHaveLength(0);
  });

  it("stops when the model is unknown to the provider", async () => {
    files.set("inbox/2026-10-01-a.md", capture("A"));
    modelError = { status: 404, body: '{"error":{"code":"model_not_found"}}' };
    await expect(backfillPage(user, { limit: 5 })).rejects.toThrow(/HTTP 404/);
  });

  it("stops when the key has no credits, though the provider says 429 or 400", async () => {
    files.set("inbox/2026-10-01-a.md", capture("A"));
    modelError = { status: 429, body: '{"error":{"message":"You have no credits remaining.","type":"insufficient_quota"}}' };
    await expect(backfillPage(user, { limit: 5 })).rejects.toThrow(/insufficient_quota/);
    modelError = { status: 400, body: '{"error":{"message":"Your credit balance is too low."}}' };
    await expect(backfillPage(user, { limit: 5 })).rejects.toThrow(/credit balance/);
    expect(puts).toHaveLength(0);
  });

  it("still counts a plain rate limit as one to try again", async () => {
    files.set("inbox/2026-10-01-a.md", capture("A"));
    modelError = { status: 429, body: '{"error":{"message":"Rate limit reached for requests","type":"requests"}}' };
    expect(await backfillPage(user, { limit: 5 })).toMatchObject({ written: 0, failed: 1 });
  });

  it("still counts a one-off provider error as one to try again", async () => {
    files.set("inbox/2026-10-01-a.md", capture("A"));
    modelError = { status: 500, body: "{}" };
    expect(await backfillPage(user, { limit: 5 })).toMatchObject({ written: 0, failed: 1 });
  });

  it("writes the files of a page one after another, never two at once", async () => {
    for (const n of ["a", "b", "c", "d", "e"]) files.set(`inbox/2026-10-0${"abcde".indexOf(n) + 1}-${n}.md`, capture(n));
    const out = await backfillPage(user, { limit: 5 });
    expect(out.written).toBe(5);
    expect(maxInFlight).toBe(1);
  });

  it("waits a second between writes, as GitHub asks for content writes", async () => {
    for (const n of ["a", "b", "c"]) files.set(`inbox/2026-10-0${"abc".indexOf(n) + 1}-${n}.md`, capture(n));
    await backfillPage(user, { limit: 5 });
    expect(gaps).toEqual([1000, 1000]);
  });

  it("stops the page when GitHub limits writes, so the card pauses instead of failing the rest", async () => {
    for (const n of ["a", "b", "c"]) files.set(`inbox/2026-10-0${"abc".indexOf(n) + 1}-${n}.md`, capture(n));
    // The first write lands; the second hits GitHub's secondary rate limit.
    putErrors.push(null, { status: 403, message: '{"message":"You have exceeded a secondary rate limit."}', retryAfter: 90 });
    const err = await backfillPage(user, { limit: 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubWriteLimitError);
    expect((err as InstanceType<typeof GitHubWriteLimitError>).retryAfter).toBe(90);
    expect(puts.map((p) => p.path)).toEqual(["inbox/2026-10-01-a.md"]);
  });

  it("logs why a write failed without the capture's name", async () => {
    files.set("inbox/2026-10-01-private-topic.md", capture("a"));
    putErrors.push({ status: 409, message: '{"message":"inbox/2026-10-01-private-topic.md does not match abc"}' });
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); });
    await backfillPage(user, { limit: 5 });
    spy.mockRestore();
    expect(logged.join("\n")).toContain("409");
    expect(logged.join("\n")).not.toContain("private-topic");
  });

  it("treats a 429 from GitHub as the same limit, with a minute's wait when it gives none", async () => {
    files.set("inbox/2026-10-01-a.md", capture("a"));
    putErrors.push({ status: 429, message: "{}" });
    const err = await backfillPage(user, { limit: 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubWriteLimitError);
    expect((err as InstanceType<typeof GitHubWriteLimitError>).retryAfter).toBe(60);
  });

  it("still counts a write GitHub turns down for another reason as one to try again", async () => {
    files.set("inbox/2026-10-01-a.md", capture("a"));
    putErrors.push({ status: 409, message: '{"message":"is at abc but expected def"}' });
    expect(await backfillPage(user, { limit: 5 })).toMatchObject({ written: 0, failed: 1 });
  });

  it("writes a line into captures without one, from inbox and applied, oldest first", async () => {
    files.set("inbox/2026-10-02-b.md", capture("B"));
    files.set("applied/2026-10-01-a.md", capture("A"));
    const res = await backfillPage(user, { limit: 10 });
    expect(res).toMatchObject({ written: 2, skipped: 0, none: 0, failed: 0, next: null });
    expect(puts.map((p) => p.path)).toEqual(["applied/2026-10-01-a.md", "inbox/2026-10-02-b.md"]);
    expect(puts[0]!.sha).toBe("sha-applied/2026-10-01-a.md");
    expect(files.get("inbox/2026-10-02-b.md")).toContain("use_it_when: Use it when shared work keeps getting dropped");
  });

  it("sends the capture's own part, not the raw capture or source text", async () => {
    files.set("inbox/2026-10-02-b.md", capture("B"));
    await backfillPage(user, { limit: 10 });
    expect(lastPrompt).toContain("Every alert needs one named owner.");
    expect(lastPrompt).not.toContain("SECRET RAW TEXT");
  });

  it("skips captures that already have a line, without a model call", async () => {
    files.set("inbox/2026-10-02-b.md", capture("B", "use_it_when: Use it when y.\n"));
    const res = await backfillPage(user, { limit: 10 });
    expect(res).toMatchObject({ written: 0, skipped: 1 });
    expect(modelCalls).toBe(0);
    expect(puts).toHaveLength(0);
  });

  it("records 'none' when the model finds nothing reusable, so a rerun skips it", async () => {
    files.set("inbox/2026-10-02-b.md", capture("B"));
    modelAnswer = { use_it_when: "none" };
    expect(await backfillPage(user, { limit: 10 })).toMatchObject({ written: 0, none: 1 });
    expect(files.get("inbox/2026-10-02-b.md")).toContain("use_it_when: none\n");
    expect(await backfillPage(user, { limit: 10 })).toMatchObject({ skipped: 1 });
  });

  it("leaves a capture unchanged when the model breaks the rules, to try again later", async () => {
    files.set("inbox/2026-10-02-b.md", capture("B"));
    modelAnswer = { use_it_when: "Alerts and on-call rotations." };
    expect(await backfillPage(user, { limit: 10 })).toMatchObject({ written: 0, failed: 1 });
    expect(puts).toHaveLength(0);
  });

  it("pages with `after`, which stays right when files move between pages", async () => {
    files.set("inbox/2026-10-01-a.md", capture("A"));
    files.set("inbox/2026-10-02-b.md", capture("B"));
    files.set("inbox/2026-10-03-c.md", capture("C"));
    const first = await backfillPage(user, { limit: 2 });
    expect(first.next).toBe("inbox/2026-10-02-b.md");
    const second = await backfillPage(user, { limit: 2, after: first.next! });
    expect(second).toMatchObject({ written: 1, next: null });
    expect(puts.map((p) => p.path)).toEqual(["inbox/2026-10-01-a.md", "inbox/2026-10-02-b.md", "inbox/2026-10-03-c.md"]);
  });

  it("pages by file name, so a capture moved to applied/ after a pause is still reached", async () => {
    files.set("inbox/2026-10-01-a.md", capture("A"));
    files.set("inbox/2026-10-02-b.md", capture("B"));
    files.set("inbox/2026-10-03-c.md", capture("C"));
    const first = await backfillPage(user, { limit: 1 });
    expect(first.next).toBe("inbox/2026-10-01-a.md");
    // Applied while the run is paused: it moves to applied/, which sorts before inbox/.
    files.set("applied/2026-10-02-b.md", files.get("inbox/2026-10-02-b.md")!);
    files.delete("inbox/2026-10-02-b.md");
    const second = await backfillPage(user, { limit: 5, after: first.next! });
    expect(second).toMatchObject({ written: 2, next: null });
    expect(puts.map((p) => p.path)).toEqual(["inbox/2026-10-01-a.md", "applied/2026-10-02-b.md", "inbox/2026-10-03-c.md"]);
  });

  it("counts a capture that moved between the listing and the read as one to try again", async () => {
    files.set("inbox/2026-10-02-b.md", capture("B"));
    vanish.add("inbox/2026-10-02-b.md");
    expect(await backfillPage(user, { limit: 10 })).toMatchObject({ written: 0, failed: 1, next: null });
  });

  it("handles a file saved with CRLF line endings, and keeps them", async () => {
    files.set("inbox/2026-10-02-b.md", capture("B").replace(/\n/g, "\r\n"));
    expect(await backfillPage(user, { limit: 10 })).toMatchObject({ written: 1, failed: 0 });
    const saved = files.get("inbox/2026-10-02-b.md")!;
    expect(saved).toContain("lowConfidence: false\r\nuse_it_when: Use it when shared work");
    expect(saved.replace(/\r\n/g, "")).not.toContain("\n");
    expect(lastPrompt).not.toContain("source_sha256");
    // A rerun sees the line and makes no model call.
    modelCalls = 0;
    expect(await backfillPage(user, { limit: 10 })).toMatchObject({ skipped: 1 });
    expect(modelCalls).toBe(0);
  });

  it("leaves archived captures alone", async () => {
    files.set("archived/2026-10-01-a.md", capture("A"));
    expect(await backfillPage(user, { limit: 10 })).toMatchObject({ written: 0, next: null });
  });
});

describe("backfillEstimate", () => {
  it("counts the inbox and applied captures and prices them on the user's model, with no model call", async () => {
    files.set("inbox/2026-10-02-b.md", capture("B"));
    files.set("applied/2026-10-01-a.md", capture("A"));
    files.set("archived/2026-10-01-z.md", capture("Z"));
    const est = await backfillEstimate(user);
    expect(est.captures).toBe(2);
    expect(est.usd).not.toBeNull();
    expect(est.usd!).toBeGreaterThan(0);
    expect(est.usd!).toBeLessThan(0.1);
    expect(est.reasoning).toBe(false);
    expect(modelCalls).toBe(0);
  });

  it("gives no price for a model with none on file", async () => {
    files.set("inbox/2026-10-02-b.md", capture("B"));
    const est = await backfillEstimate({ ...user, llm_model: "some-unknown-model" } as unknown as User);
    expect(est).toEqual({ captures: 1, usd: null, reasoning: false });
  });

  it("says when the model reasons first, so the card can say the cost may run higher", async () => {
    files.set("inbox/2026-10-02-b.md", capture("B"));
    const est = await backfillEstimate({ ...user, llm_provider: "anthropic", llm_effort: "high" } as unknown as User);
    expect(est.reasoning).toBe(true);
  });
});
