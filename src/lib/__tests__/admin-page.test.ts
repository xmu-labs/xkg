import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { AdminStats } from "@/lib/admin-stats";

/**
 * /admin is the owner's phone-readable view of the apply-stats numbers. Only
 * the GitHub login in ADMIN_GITHUB_LOGIN can open it; anyone else, signed in
 * or not, gets the same 404 as a page that doesn't exist. It shows counts and
 * dates only, never a capture name, content or code.
 */

let session: Record<string, unknown> | null = null;
const readStats = vi.fn();
vi.mock("@/lib/session", () => ({ getSession: async () => session }));
vi.mock("@/lib/admin-stats", async () => {
  const real = await vi.importActual<typeof import("@/lib/admin-stats")>("@/lib/admin-stats");
  return { ...real, readStats: (...a: unknown[]) => readStats(...a) };
});

const { default: AdminPage } = await import("@/app/admin/page");
const { isOwner } = await import("@/lib/admin-owner");
const { statsSummary } = await import("@/lib/admin-stats");

const OWNER = { id: 1, github_username: "Owner-Login" };
const OTHER = { id: 2, github_username: "someone-else" };

const STATS: AdminStats = {
  weeks: [
    { userId: 1, weekStart: "2026-10-26", captures: 2, capturesWithCommit: 1, capturesWithWhy: 1, harnesses: { codex: 2 }, sources: { cardOnly: 1, briefingOnly: 1, both: 0, other: 0, none: 0 } },
    { userId: 2, weekStart: "2026-11-02", captures: 1, capturesWithCommit: 1, capturesWithWhy: 0, harnesses: { "claude-code": 1 }, sources: { cardOnly: 0, briefingOnly: 0, both: 1, other: 0, none: 0 } },
  ],
  matching: [
    { userId: 1, weekStart: "2026-10-26", scorer: "jev", matches: 10, suggestions: 3, medianTokens: 3000 },
    { userId: 1, weekStart: "2026-11-02", scorer: "jev", matches: 5, suggestions: 1, medianTokens: 4000 },
    { userId: 2, weekStart: "2026-11-02", scorer: null, matches: 4, suggestions: 2, medianTokens: null },
  ],
  handoffs: [
    { userId: 1, weekStart: "2026-11-02", counts: { queued: { auto: 2, button: 1 }, offered: 4, applied: 0, appliedWithCommit: 0, declined: { wrongFiles: 1, doesntFit: 0, other: 0 }, done: 0, later: 1, expired: 1, reverted: 0 } },
  ],
  setup: {
    users: [{ userId: 1, signedUp: "2026-10-28", repo: true, aiKey: true, firstCapture: "2026-10-28", firstAgentCall: null, firstShown: null, firstApply: null, stoppedBefore: "agent" as const }],
    reached: { signedUp: 3, repo: 3, aiKey: 2, capture: 2, agent: 1, shown: 1, apply: 0 },
  },
};

async function render(weeks?: string): Promise<string> {
  const el = (await AdminPage({ searchParams: Promise.resolve(weeks ? { weeks } : {}) })) as ReactElement;
  return renderToStaticMarkup(el);
}

/** The digest Next.js gives notFound(), so the request answers 404. */
async function notFoundDigest(): Promise<string | undefined> {
  try {
    await render();
  } catch (err) {
    return (err as { digest?: string }).digest;
  }
  return undefined;
}

beforeEach(() => {
  process.env.ADMIN_GITHUB_LOGIN = "owner-login";
  session = OWNER;
  readStats.mockReset().mockResolvedValue(STATS);
});

describe("isOwner", () => {
  it("matches the GitHub login in ADMIN_GITHUB_LOGIN, ignoring case", () => {
    expect(isOwner(OWNER)).toBe(true);
    expect(isOwner(OTHER)).toBe(false);
    expect(isOwner(null)).toBe(false);
  });

  // fails_when: an unset env var lets every account in
  it("lets nobody in when ADMIN_GITHUB_LOGIN isn't set", () => {
    delete process.env.ADMIN_GITHUB_LOGIN;
    expect(isOwner(OWNER)).toBe(false);
    process.env.ADMIN_GITHUB_LOGIN = "  ";
    expect(isOwner({ github_username: "" })).toBe(false);
  });
});

describe("statsSummary", () => {
  it("adds up every account and week in the window", () => {
    expect(statsSummary(STATS)).toEqual({
      applies: { captures: 3, withCommit: 2, withWhy: 1, harnesses: { codex: 2, "claude-code": 1 } },
      matching: [
        { scorer: "jev", matches: 15, suggestions: 4 },
        { scorer: "evidence", matches: 4, suggestions: 2 },
      ],
      handoffs: { queued: 3, offered: 4, applied: 0, declined: 1, later: 1, done: 0, expired: 1, reverted: 0 },
      accounts: 2,
      setup: STATS.setup.reached,
    });
  });
});

describe("/admin", () => {
  // fails_when: the owner can't read the numbers on the page
  it("shows the owner the counts for the window", async () => {
    const html = await render();
    expect(readStats).toHaveBeenCalledWith(4);
    expect(html).toContain("Last 4 weeks");
    expect(html).toMatch(/Captures applied<\/[a-z]+>\s*<[^>]+>3</);
    expect(html).toMatch(/Offered<\/[a-z]+>\s*<[^>]+>4</);
    expect(html).toMatch(/Matches by Jev<\/[a-z]+>\s*<[^>]+>15</);
    expect(html).toMatch(/Signed up<\/[a-z]+>\s*<[^>]+>3</);
    expect(html.replaceAll("&#x27;", "'")).toContain("Matches by the account's own model");
  });

  it("reads the window from ?weeks, kept between 1 and 52", async () => {
    await render("12");
    expect(readStats).toHaveBeenLastCalledWith(12);
    await render("400");
    expect(readStats).toHaveBeenLastCalledWith(52);
    await render("nope");
    expect(readStats).toHaveBeenLastCalledWith(4);
  });

  // fails_when: the page tells a non-owner it exists, or shows them any number
  it("is a 404 for any other signed-in account and for a signed-out visitor", async () => {
    session = OTHER;
    expect(await notFoundDigest()).toMatch(/404/);
    session = null;
    expect(await notFoundDigest()).toMatch(/404/);
    expect(readStats).not.toHaveBeenCalled();
  });

  it("is a 404 for everyone when ADMIN_GITHUB_LOGIN isn't set", async () => {
    delete process.env.ADMIN_GITHUB_LOGIN;
    expect(await notFoundDigest()).toMatch(/404/);
  });

  // fails_when: the page grows a capture name, a repo, or an account's GitHub login
  it("shows counts only: no account login, capture name or repo", async () => {
    const html = await render();
    expect(html).not.toContain("someone-else");
    expect(html).not.toContain("Owner-Login");
    expect(html).not.toMatch(/\.md\b/);
  });

  it("says plainly when the numbers can't be read", async () => {
    readStats.mockRejectedValue(new Error("db down"));
    expect((await render()).replaceAll("&#x27;", "'")).toContain("Couldn't read the stats. Reload in a moment.");
  });
});
