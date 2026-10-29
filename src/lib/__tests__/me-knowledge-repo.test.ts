import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Settings shows where captures are stored. GET /api/me returns the knowledge
 * repo, and when the user has renamed it on GitHub, the saved name follows the
 * rename so xkg stops depending on GitHub's redirect from the old name.
 */

const getSession = vi.fn();
const updateUserRepo = vi.fn();

vi.mock("@/lib/session", () => ({ getSession: () => getSession() }));
vi.mock("@/lib/db", () => ({
  ensureLlmColumns: vi.fn(),
  ensureProfileColumns: vi.fn(),
  updateUserProfile: vi.fn(),
  updateUserLlmKey: vi.fn(),
  updateUserLlmSettings: vi.fn(),
  updateUserRepo: (...a: unknown[]) => updateUserRepo(...a),
}));

const { GET } = await import("@/app/api/me/route");

const user = {
  id: 7,
  github_username: "octo",
  github_token: "gho_token",
  github_repo: "octo/mnemos-knowledge",
  display_name: null,
  avatar_data: null,
  api_key: "h",
  pin_hash: "p",
  llm_provider: "anthropic",
  llm_api_key: "sk-ant-oldkey-1234",
  llm_model: null,
  llm_effort: null,
};

const fetchMock = vi.fn();

function githubAnswers(status: number, body: unknown) {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

beforeEach(() => {
  getSession.mockReset().mockResolvedValue({ ...user });
  updateUserRepo.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/me — knowledge repo", () => {
  it("returns the saved repo when GitHub reports the same name", async () => {
    githubAnswers(200, { full_name: "octo/mnemos-knowledge" });
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).knowledgeRepo).toBe("octo/mnemos-knowledge");
    expect(updateUserRepo).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/octo/mnemos-knowledge",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer gho_token" }) }),
    );
  });

  it("saves and returns the new name after a rename on GitHub", async () => {
    githubAnswers(200, { full_name: "octo/xkg-knowledge" });
    const res = await GET();
    expect((await res.json()).knowledgeRepo).toBe("octo/xkg-knowledge");
    expect(updateUserRepo).toHaveBeenCalledWith(7, "octo/xkg-knowledge");
  });

  it("keeps the saved name when GitHub can't be reached", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).knowledgeRepo).toBe("octo/mnemos-knowledge");
    expect(updateUserRepo).not.toHaveBeenCalled();
  });

  it("keeps the saved name when GitHub answers with an error", async () => {
    githubAnswers(404, { message: "Not Found" });
    const res = await GET();
    expect((await res.json()).knowledgeRepo).toBe("octo/mnemos-knowledge");
    expect(updateUserRepo).not.toHaveBeenCalled();
  });

  it("returns null and skips GitHub before onboarding", async () => {
    getSession.mockResolvedValue({ ...user, github_repo: null });
    const res = await GET();
    expect((await res.json()).knowledgeRepo).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
