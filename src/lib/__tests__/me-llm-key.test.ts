import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Settings can switch provider and replace the key after onboarding. A key is
 * checked with its provider before it's saved, and a switch clears the old
 * provider's model.
 */

const getSession = vi.fn();
const updateUserLlmKey = vi.fn();
const updateUserLlmSettings = vi.fn();
const verifyLlmKey = vi.fn();

vi.mock("@/lib/session", () => ({ getSession: () => getSession() }));
vi.mock("@/lib/db", () => ({
  ensureLlmColumns: vi.fn(),
  ensureProfileColumns: vi.fn(),
  updateUserProfile: vi.fn(),
  updateUserLlmKey: (...a: unknown[]) => updateUserLlmKey(...a),
  updateUserLlmSettings: (...a: unknown[]) => updateUserLlmSettings(...a),
}));
vi.mock("@/lib/llm", async (orig) => ({
  ...(await orig<typeof import("../llm")>()),
  verifyLlmKey: (...a: unknown[]) => verifyLlmKey(...a),
}));

const { PATCH } = await import("@/app/api/me/route");

const user = {
  id: 7,
  github_username: "octo",
  display_name: null,
  avatar_data: null,
  api_key: "h",
  pin_hash: "p",
  llm_provider: "anthropic",
  llm_api_key: "sk-ant-oldkey-1234",
  llm_model: "claude-opus-5-5",
  llm_effort: "high",
};

function patch(body: unknown) {
  return PATCH(new NextRequest("http://x/api/me", { method: "PATCH", body: JSON.stringify(body) }));
}

beforeEach(() => {
  getSession.mockReset().mockResolvedValue(user);
  updateUserLlmKey.mockReset();
  updateUserLlmSettings.mockReset();
  verifyLlmKey.mockReset().mockResolvedValue(null);
});

describe("PATCH /api/me — provider and key", () => {
  it("switches provider with a checked key and clears the old model", async () => {
    const res = await patch({ llmProvider: "openai", llmApiKey: " sk-new-abcd9876 " });
    expect(res.status).toBe(200);
    expect(verifyLlmKey).toHaveBeenCalledWith("openai", "sk-new-abcd9876");
    expect(updateUserLlmKey).toHaveBeenCalledWith(7, "openai", "sk-new-abcd9876");
    expect(updateUserLlmSettings).toHaveBeenCalledWith(7, null, "high");
    const me = await res.json();
    expect(me).toMatchObject({ llmProvider: "openai", llmModel: null, llmKeyHint: "9876", defaultModel: "gpt-4o-mini" });
  });

  it("refuses a provider switch without a key", async () => {
    const res = await patch({ llmProvider: "google" });
    expect(res.status).toBe(400);
    expect(updateUserLlmKey).not.toHaveBeenCalled();
  });

  it("does not save a key the provider rejects", async () => {
    verifyLlmKey.mockResolvedValue("Anthropic rejected that key. Check it and try again.");
    const res = await patch({ llmApiKey: "sk-ant-typo" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/rejected/);
    expect(updateUserLlmKey).not.toHaveBeenCalled();
  });

  it("replaces the key on the same provider and keeps the model", async () => {
    const res = await patch({ llmApiKey: "sk-ant-fresh-5678" });
    expect(res.status).toBe(200);
    expect(updateUserLlmKey).toHaveBeenCalledWith(7, "anthropic", "sk-ant-fresh-5678");
    expect(updateUserLlmSettings).not.toHaveBeenCalled();
    expect((await res.json()).llmModel).toBe("claude-opus-5-5");
  });

  it("rejects an unknown provider", async () => {
    expect((await patch({ llmProvider: "mistral", llmApiKey: "k" })).status).toBe(400);
  });

  it("never returns the key itself", async () => {
    const me = await (await patch({ llmEffort: "low" })).json();
    expect(JSON.stringify(me)).not.toContain("oldkey");
    expect(me.llmKeyHint).toBe("1234");
  });
});

describe("verifyLlmKey", () => {
  it("blocks a 401 and lets an outage through", async () => {
    const { verifyLlmKey: real } = await vi.importActual<typeof import("../llm")>("../llm");
    const spy = vi.spyOn(globalThis, "fetch");
    spy.mockResolvedValueOnce(new Response("", { status: 401 }));
    expect(await real("openai", "bad")).toMatch(/OpenAI rejected/);
    spy.mockResolvedValueOnce(new Response("", { status: 503 }));
    expect(await real("anthropic", "ok")).toBeNull();
    spy.mockResolvedValueOnce(new Response("", { status: 400 }));
    expect(await real("google", "bad")).toMatch(/Google rejected/);
    spy.mockRestore();
  });
});
