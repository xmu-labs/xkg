import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * setup_steps and the setup funnel: for each new account, which setup step it
 * reached and when, so the operator can see where people stop between signing
 * up and their first apply. A step row holds the user id, the step name and
 * the date it first happened. Nothing about the capture or the agent.
 */

const queries: Array<{ text: string; values: unknown[] }> = [];
let rows: unknown[] = [];
let failInsert = false;

vi.mock("../sql", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    queries.push({ text, values });
    if (failInsert && text.startsWith("INSERT")) return Promise.reject(new Error("db down"));
    return Promise.resolve({ rows: text.startsWith("SELECT") ? rows : [], rowCount: 0 });
  },
}));

const { recordSetupStep, setupFunnel, forgetRecordedSteps } = await import("../setup-steps");

const inserts = () => queries.filter((q) => q.text.startsWith("INSERT"));
const selects = () => queries.filter((q) => q.text.startsWith("SELECT"));

beforeEach(() => {
  queries.length = 0;
  rows = [];
  failInsert = false;
  forgetRecordedSteps();
});

describe("recordSetupStep", () => {
  it("records the first time a step happens, once per user and step", async () => {
    await recordSetupStep(7, "capture");

    expect(inserts()).toHaveLength(1);
    expect(inserts()[0]!.text).toBe(
      "INSERT INTO setup_steps (user_id, step) VALUES (?, ?) ON CONFLICT (user_id, step) DO NOTHING",
    );
    expect(inserts()[0]!.values).toEqual([7, "capture"]);
  });

  it("skips the write when this instance already recorded the step", async () => {
    await recordSetupStep(7, "agent");
    await recordSetupStep(7, "agent");
    await recordSetupStep(8, "agent");

    expect(inserts().map((q) => q.values)).toEqual([[7, "agent"], [8, "agent"]]);
  });

  it("never throws when the database fails, and tries again next time", async () => {
    failInsert = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(recordSetupStep(7, "capture")).resolves.toBeUndefined();

    failInsert = false;
    await recordSetupStep(7, "capture");
    expect(inserts()).toHaveLength(2);
  });
});

describe("setupFunnel", () => {
  const row = (over: Record<string, unknown>) => ({
    user_id: 1,
    created_at: "2026-11-02T10:00:00Z",
    has_repo: false,
    has_ai_key: false,
    first_capture: null,
    first_agent: null,
    first_shown: null,
    first_apply: null,
    ...over,
  });

  it("reads accounts that signed up in the window, with agent-side showings only", async () => {
    await setupFunnel("2026-11-03", 4);

    const q = selects().find((s) => s.text.includes("FROM users"))!;
    expect(q.text).toContain("WHERE u.created_at >= ?");
    expect(q.values).toContain("2026-10-12");
    // The capture card in the web app is not an agent seeing the capture.
    expect(q.text).toContain("channel <> 'where'");
    expect(q.text).not.toContain("github_username");
  });

  it("gives each account its step dates and the first step it has not reached", async () => {
    rows = [
      row({ user_id: 1, has_repo: true, has_ai_key: true, first_capture: "2026-11-02T11:00:00Z", first_agent: "2026-11-02T12:00:00Z", first_shown: "2026-11-03T08:00:00Z", first_apply: "2026-11-03T09:00:00Z" }),
      row({ user_id: 2, has_repo: true, has_ai_key: true, first_capture: "2026-11-02T11:00:00Z" }),
      row({ user_id: 3, has_repo: true }),
      // An agent can capture before the web app ever does: steps are read in order, not by date.
      row({ user_id: 4, has_repo: true, has_ai_key: true, first_agent: "2026-11-02T12:00:00Z" }),
    ];

    const funnel = await setupFunnel("2026-11-03", 4);

    expect(funnel.users).toEqual([
      { userId: 1, signedUp: "2026-11-02", repo: true, aiKey: true, firstCapture: "2026-11-02", firstAgentCall: "2026-11-02", firstShown: "2026-11-03", firstApply: "2026-11-03", stoppedBefore: null },
      { userId: 2, signedUp: "2026-11-02", repo: true, aiKey: true, firstCapture: "2026-11-02", firstAgentCall: null, firstShown: null, firstApply: null, stoppedBefore: "agent" },
      { userId: 3, signedUp: "2026-11-02", repo: true, aiKey: false, firstCapture: null, firstAgentCall: null, firstShown: null, firstApply: null, stoppedBefore: "aiKey" },
      { userId: 4, signedUp: "2026-11-02", repo: true, aiKey: true, firstCapture: null, firstAgentCall: "2026-11-02", firstShown: null, firstApply: null, stoppedBefore: "capture" },
    ]);
    expect(funnel.reached).toEqual({ signedUp: 4, repo: 4, aiKey: 3, capture: 2, agent: 2, shown: 1, apply: 1 });
  });

  it("returns an empty funnel when nobody signed up in the window", async () => {
    const funnel = await setupFunnel("2026-11-03", 1);
    expect(funnel).toEqual({ users: [], reached: { signedUp: 0, repo: 0, aiKey: 0, capture: 0, agent: 0, shown: 0, apply: 0 } });
  });
});
