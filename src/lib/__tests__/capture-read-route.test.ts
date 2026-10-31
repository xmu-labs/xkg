import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * The capture page's read: one capture from the user's knowledge repo, found
 * in whichever folder it is in now, as plain fields.
 */

const user = { id: 7, github_token: "gho_user", github_repo: "o/knowledge" };
let session: Record<string, unknown> | null = user;
const files = new Map<string, { content: string; sha: string }>();
const reads: string[] = [];
const down = new Set<string>();

vi.mock("@/lib/session", () => ({ getSession: async () => session }));
vi.mock("@/lib/github", async () => {
  const { GitHubReadError } = await vi.importActual<typeof import("@/lib/github")>("@/lib/github");
  return {
    GitHubReadError,
    readFileStrict: async (_t: string, _r: string, path: string) => {
      reads.push(path);
      if (down.has(path)) throw new GitHubReadError(path, 503);
      return files.get(path) ?? null;
    },
  };
});

const { GET } = await import("@/app/api/captures/read/route");

const NAME = "2026-10-28-llm-memory.md";
const INDEX = `| Date | Capture | Summary | Tags | Type |
|------|---------|---------|------|------|
| 2026-10-28 | [llm-memory](applied/${NAME}) | Memory goes into the prompt.... | llm | article |
| 2026-10-20 | [routing](inbox/2026-10-20-routing.md) | Route by cost.... | llm | post |
`;
const FILE = `---\ndate: 2026-10-28\nurl: https://example.com/post\ntags: llm\nstatus: applied\n---\n\n# LLM memory\n\n## Core idea\nMemory goes into the prompt.\n\n## Links to memory\n- [routing](../inbox/2026-10-20-routing.md) — both are about cost\n`;

const get = (name: string | null) =>
  GET(new NextRequest(`https://xkg.test/api/captures/read${name === null ? "" : `?name=${encodeURIComponent(name)}`}`));

beforeEach(() => {
  session = user;
  files.clear();
  reads.length = 0;
  down.clear();
  files.set("INDEX.md", { content: INDEX, sha: "i" });
});

describe("GET /api/captures/read", () => {
  it("reads the capture from the folder its index row names", async () => {
    files.set(`applied/${NAME}`, { content: FILE, sha: "a" });
    const res = await get(NAME);
    expect(res.status).toBe(200);
    const { capture } = await res.json();
    expect(capture).toMatchObject({
      filename: NAME,
      status: "applied",
      title: "LLM memory",
      coreIdea: "Memory goes into the prompt.",
      fileUrl: `https://github.com/o/knowledge/blob/main/applied/${NAME}`,
      links: [{ name: "2026-10-20-routing.md", slug: "routing", note: "both are about cost", summary: "Route by cost." }],
    });
    expect(reads).toEqual(["INDEX.md", `applied/${NAME}`]);
  });

  it("finds a capture with no index row in any folder", async () => {
    files.set("archived/2026-01-02-old.md", { content: "---\ndate: 2026-01-02\n---\n\n# Old\n", sha: "o" });
    const res = await get("2026-01-02-old.md");
    expect(res.status).toBe(200);
    expect((await res.json()).capture).toMatchObject({ status: "archived", title: "Old" });
  });

  it("finds a capture that moved since its index row was written", async () => {
    files.set(`archived/${NAME}`, { content: FILE, sha: "a" });
    expect((await (await get(NAME)).json()).capture.status).toBe("archived");
  });

  it("says a missing capture is gone", async () => {
    const res = await get("2026-01-01-gone.md");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("This capture isn't in your knowledge repo anymore.");
  });

  it.each([null, "../INDEX.md", "inbox/x.md", "RULES", "a b.md"])("refuses the name %s", async (name) => {
    const res = await get(name);
    expect(res.status).toBe(400);
    expect(reads).toEqual([]);
  });

  it("sends a signed-out user to sign in", async () => {
    session = null;
    expect((await get(NAME)).status).toBe(401);
  });

  it("says GitHub failed instead of calling the capture gone", async () => {
    down.add(`applied/${NAME}`);
    expect((await get(NAME)).status).toBe(502);
  });
});
