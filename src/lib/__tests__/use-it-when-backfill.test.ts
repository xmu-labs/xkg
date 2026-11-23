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
let lastPrompt = "";

vi.mock("../github", () => ({
  githubGet: async (_t: string, _r: string, dir: string) => {
    const names = [...files.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => ({ name: p.slice(dir.length + 1) }));
    return names.length ? { ok: true, status: 200, data: names } : { ok: false, status: 404, data: null };
  },
  readFileStrict: async (_t: string, _r: string, path: string) => (files.has(path) ? { content: files.get(path)!, sha: `sha-${path}` } : null),
  githubPut: async (_t: string, _r: string, path: string, content: string, _m: string, sha?: string) => {
    puts.push({ path, content, sha });
    files.set(path, content);
  },
}));
vi.mock("../llm-spend", () => ({ recordSpend: async () => {} }));

vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
  if (!String(url).includes("api.openai.com")) throw new Error(`unexpected fetch ${url}`);
  modelCalls++;
  lastPrompt = JSON.stringify(JSON.parse(init.body).messages);
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(modelAnswer) } }], usage: { prompt_tokens: 900, completion_tokens: 30 } }), { status: 200 });
});

const { addUseItWhen, backfillPage, backfillEstimate } = await import("../use-it-when-backfill");
const user = { id: 7, llm_api_key: "k", github_token: "t", github_repo: "o/r", llm_provider: "openai", llm_model: null, llm_effort: null } as unknown as User;

function capture(title: string, extra = ""): string {
  return `---\ndate: 2026-10-01\nsource: ${title}\ntype: notes\nstatus: inbox\nlowConfidence: false\n${extra}source_sha256: abc\n---\n\n# ${title}\n\n## Core idea\nEvery alert needs one named owner.\n\n## Key takeaways\n- A channel is not an owner.\n\n## Links to memory\n_none yet_\n\n---\n\n<details>\n<summary>Raw capture</summary>\n\nSECRET RAW TEXT\n\n</details>\n`;
}

beforeEach(() => {
  files.clear();
  puts.length = 0;
  modelCalls = 0;
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
    expect(modelCalls).toBe(0);
  });

  it("gives no price for a model with none on file", async () => {
    files.set("inbox/2026-10-02-b.md", capture("B"));
    const est = await backfillEstimate({ ...user, llm_model: "some-unknown-model" } as unknown as User);
    expect(est).toEqual({ captures: 1, usd: null });
  });
});
