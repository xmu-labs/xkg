import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * POST /api/admin/rebuild-handoff-index?user=<id> makes a user's
 * handoff_scores again from git (HANDOFFS.md and the captures' Handoff logs),
 * behind the admin secret.
 */

const getUserById = vi.fn();
const rebuildHandoffIndex = vi.fn();
vi.mock("@/lib/db", () => ({ getUserById: (...a: unknown[]) => getUserById(...a) }));
vi.mock("@/lib/handoff-learning", () => ({ rebuildHandoffIndex: (...a: unknown[]) => rebuildHandoffIndex(...a) }));

beforeAll(() => {
  process.env.ADMIN_SECRET = "admin-test-secret";
});

const { POST } = await import("@/app/api/admin/rebuild-handoff-index/route");

const post = (query: string, secret: string | null = "admin-test-secret") =>
  POST(new NextRequest(`https://xkg.test/api/admin/rebuild-handoff-index${query}`, {
    method: "POST",
    headers: secret === null ? {} : { "x-admin-secret": secret },
  }));

const user = { id: 7, github_token: "gho", github_repo: "o/knowledge" };

beforeEach(() => {
  getUserById.mockReset().mockResolvedValue(user);
  rebuildHandoffIndex.mockReset().mockResolvedValue({ captures: 2, rows: 3 });
});

describe("POST /api/admin/rebuild-handoff-index", () => {
  // protects: only the operator can rebuild; fails_when: a request without the secret reaches the rebuild; no_claim: none
  it("needs the admin secret", async () => {
    expect((await post("?user=7", null)).status).toBe(401);
    expect((await post("?user=7", "wrong")).status).toBe(401);
    expect(rebuildHandoffIndex).not.toHaveBeenCalled();
  });

  // protects: spec AC16, one user's index is rebuilt from git and the counts come back; fails_when: another user is rebuilt or the counts are lost; no_claim: the rebuild itself (handoff-learning tests)
  it("rebuilds the named user's index", async () => {
    const res = await post("?user=7");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: 7, captures: 2, rows: 3 });
    expect(getUserById).toHaveBeenCalledWith(7);
    expect(rebuildHandoffIndex).toHaveBeenCalledWith(user, expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  });

  // protects: a bad id is refused, not guessed; fails_when: a missing or non-numeric id or an unknown user reaches the rebuild; no_claim: none
  it("refuses a missing or unknown user", async () => {
    expect((await post("")).status).toBe(400);
    expect((await post("?user=abc")).status).toBe(400);
    getUserById.mockResolvedValue(null);
    expect((await post("?user=9")).status).toBe(404);
    expect(rebuildHandoffIndex).not.toHaveBeenCalled();
  });

  // protects: a failed rebuild says so; fails_when: an error reads as success; no_claim: none
  it("reports a failed rebuild", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    rebuildHandoffIndex.mockRejectedValue(new Error("GitHub down"));
    expect((await post("?user=7")).status).toBe(500);
    spy.mockRestore();
  });
});
