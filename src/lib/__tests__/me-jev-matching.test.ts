import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Settings → AI model → "Where it applies": the user chooses whether TypeSafe's
 * Jev (on xkg's key) or their own model decides where a capture applies. The
 * choice is offered only when this server has a TypeSafe key.
 */

const getSession = vi.fn();
const updateUserLlmSettings = vi.fn();
const updateUserJevMatching = vi.fn();

vi.mock("@/lib/session", () => ({ getSession: () => getSession() }));
vi.mock("@/lib/db", () => ({
  ensureLlmColumns: vi.fn(),
  ensureProfileColumns: vi.fn(),
  updateUserProfile: vi.fn(),
  updateUserLlmKey: vi.fn(),
  updateUserLlmSettings: (...a: unknown[]) => updateUserLlmSettings(...a),
  updateUserNudgeDismissed: vi.fn(),
  updateUserJevMatching: (...a: unknown[]) => updateUserJevMatching(...a),
  updateUserRepo: vi.fn(),
}));
vi.mock("@/lib/github", () => ({ currentRepoName: vi.fn() }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: vi.fn() }));

const { GET, PATCH } = await import("@/app/api/me/route");

const user = {
  id: 7, github_username: "octo", display_name: null, avatar_data: null, api_key: "h", pin_hash: "p",
  llm_provider: "openai", llm_api_key: "k", llm_model: null, llm_effort: null,
  model_nudge_dismissed_for: null, jev_matching: null, github_repo: null,
};

function patch(body: unknown) {
  return PATCH(new NextRequest("http://x/api/me", { method: "PATCH", body: JSON.stringify(body) }));
}

beforeEach(() => {
  getSession.mockReset().mockResolvedValue(user);
  updateUserLlmSettings.mockReset();
  updateUserJevMatching.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/api/me — who decides where a capture applies", () => {
  // protects: Settings learns whether to offer the choice, and today's default reads as Jev on; fails_when: jevAvailable ignores the key, or an unset choice reads as off; no_claim: none
  it("offers the choice only when the server has a TypeSafe key, and an unset choice reads as on", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "ts-key");
    expect(await (await GET()).json()).toMatchObject({ jevAvailable: true, jevMatching: true });

    vi.stubEnv("TYPESAFE_API_KEY", "");
    expect(await (await GET()).json()).toMatchObject({ jevAvailable: false, jevMatching: true });
  });

  // protects: "Your model" saves on its own and comes back off; fails_when: the field is ignored, hits "Nothing to update", or touches the model settings; no_claim: the database write (db tests)
  it("saves the choice on its own", async () => {
    const res = await patch({ jevMatching: false });
    expect(res.status).toBe(200);
    expect(updateUserJevMatching).toHaveBeenCalledWith(7, false);
    expect(updateUserLlmSettings).not.toHaveBeenCalled();
    expect((await res.json()).jevMatching).toBe(false);
  });

  // protects: the choice rides along with "Save AI settings"; fails_when: either half is dropped; no_claim: none
  it("saves it together with the model settings", async () => {
    getSession.mockResolvedValue({ ...user, jev_matching: false });
    const res = await patch({ llmModel: null, llmEffort: "low", jevMatching: true });
    expect(res.status).toBe(200);
    expect(updateUserLlmSettings).toHaveBeenCalledWith(7, null, "low");
    expect(updateUserJevMatching).toHaveBeenCalledWith(7, true);
    expect((await res.json()).jevMatching).toBe(true);
  });

  // protects: an unrelated save keeps the stored choice; fails_when: a model save resets "off" to on; no_claim: none
  it("keeps a saved off when only the model changes", async () => {
    getSession.mockResolvedValue({ ...user, jev_matching: false });
    const res = await patch({ llmEffort: "high" });
    expect(updateUserJevMatching).not.toHaveBeenCalled();
    expect((await res.json()).jevMatching).toBe(false);
  });

  // protects: only a boolean is stored; fails_when: a string or null is saved; no_claim: none
  it.each([["false"], [null], [1]])("rejects %j", async (value) => {
    const res = await patch({ jevMatching: value });
    expect(res.status).toBe(400);
    expect(updateUserJevMatching).not.toHaveBeenCalled();
  });
});
