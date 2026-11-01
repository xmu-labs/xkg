import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * "Keep mine" on the faster-model hint saves the model and effort it was shown
 * for, so the hint stays quiet for that setup. "Use" switches the model and
 * saves the same value in one request.
 */

const getSession = vi.fn();
const updateUserLlmSettings = vi.fn();
const updateUserNudgeDismissed = vi.fn();

vi.mock("@/lib/session", () => ({ getSession: () => getSession() }));
vi.mock("@/lib/db", () => ({
  ensureLlmColumns: vi.fn(),
  ensureProfileColumns: vi.fn(),
  updateUserProfile: vi.fn(),
  updateUserLlmKey: vi.fn(),
  updateUserLlmSettings: (...a: unknown[]) => updateUserLlmSettings(...a),
  updateUserNudgeDismissed: (...a: unknown[]) => updateUserNudgeDismissed(...a),
}));

const { PATCH } = await import("@/app/api/me/route");

const user = {
  id: 7, github_username: "octo", display_name: null, avatar_data: null, api_key: "h", pin_hash: "p",
  llm_provider: "openai", llm_api_key: "k", llm_model: "gpt-6.1-terra", llm_effort: "high",
  model_nudge_dismissed_for: null,
};

function patch(body: unknown) {
  return PATCH(new NextRequest("http://x/api/me", { method: "PATCH", body: JSON.stringify(body) }));
}

beforeEach(() => {
  getSession.mockReset().mockResolvedValue(user);
  updateUserLlmSettings.mockReset();
  updateUserNudgeDismissed.mockReset();
});

describe("PATCH /api/me — faster-model hint", () => {
  // protects: "Keep mine" saves on its own and never hits "Nothing to update"; fails_when: the field is ignored or 400s; no_claim: the database write (db tests)
  it("saves the kept setup on its own", async () => {
    const res = await patch({ modelNudgeDismissedFor: "gpt-6.1-terra/high" });
    expect(res.status).toBe(200);
    expect(updateUserNudgeDismissed).toHaveBeenCalledWith(7, "gpt-6.1-terra/high");
    expect(updateUserLlmSettings).not.toHaveBeenCalled();
    expect((await res.json()).modelNudgeDismissedFor).toBe("gpt-6.1-terra/high");
  });

  // protects: "Use" switches the model and records the answer in one request; fails_when: either half is dropped; no_claim: none
  it("switches the model and saves the answer together", async () => {
    const res = await patch({ llmModel: "gpt-4.1", llmEffort: null, modelNudgeDismissedFor: "gpt-6.1-terra/high" });
    expect(res.status).toBe(200);
    expect(updateUserLlmSettings).toHaveBeenCalledWith(7, "gpt-4.1", null);
    expect(updateUserNudgeDismissed).toHaveBeenCalledWith(7, "gpt-6.1-terra/high");
    const body = await res.json();
    expect(body).toMatchObject({ llmModel: "gpt-4.1", llmEffort: null, modelNudgeDismissedFor: "gpt-6.1-terra/high" });
  });

  // protects: the hint state comes back with the profile; fails_when: GET/PATCH omit it; no_claim: none
  it("returns the saved value with the profile", async () => {
    getSession.mockResolvedValue({ ...user, model_nudge_dismissed_for: "gpt-6.1-terra/auto" });
    const res = await patch({ llmEffort: "low" });
    expect((await res.json()).modelNudgeDismissedFor).toBe("gpt-6.1-terra/auto");
  });

  // protects: null clears it; fails_when: null is rejected; no_claim: none
  it("clears it with null", async () => {
    const res = await patch({ modelNudgeDismissedFor: null });
    expect(res.status).toBe(200);
    expect(updateUserNudgeDismissed).toHaveBeenCalledWith(7, null);
  });

  // protects: only a short model/effort value is stored; fails_when: a number or a long string is saved; no_claim: none
  it.each([[42], ["x".repeat(201)], ["no-slash"]])("rejects %j", async (value) => {
    const res = await patch({ modelNudgeDismissedFor: value });
    expect(res.status).toBe(400);
    expect(updateUserNudgeDismissed).not.toHaveBeenCalled();
  });
});
