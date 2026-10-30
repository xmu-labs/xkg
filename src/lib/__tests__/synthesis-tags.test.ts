import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Rules for a tag are made from the captures that carry that tag, matched
 * exactly against the index's tag column, not from any row that contains
 * the tag's letters somewhere.
 */

const files = new Map<string, string>();
const synthesizeRules = vi.fn();
vi.mock("../github", () => ({
  readFile: async (_t: string, _r: string, path: string) => (files.has(path) ? { content: files.get(path)!, sha: "s" } : null),
  githubPut: vi.fn(),
}));
vi.mock("../llm", () => ({ synthesizeRules: (...a: unknown[]) => synthesizeRules(...a) }));

const { synthesizeTopic } = await import("../synthesis");

const INDEX = `| Date | Capture | Summary | Tags | Type |
|---|---|---|---|---|
| 2026-10-28 | [email-triage](inbox/2026-10-28-email-triage.md) | Sort email by sender.... | productivity | post |
| 2026-10-27 | [agent-loops](applied/2026-10-27-agent-loops.md) | Loops for agents.... | ai, agents | article |
| 2026-10-26 | [paint](archived/2026-10-26-paint.md) | Paint the shed.... | AI | notes |
| 2026-10-25 | [chain](inbox/2026-10-25-chain.md) | Chains.... | openai | notes |
`;

beforeEach(() => {
  files.clear();
  for (const f of ["inbox/2026-10-28-email-triage.md", "applied/2026-10-27-agent-loops.md", "archived/2026-10-26-paint.md", "inbox/2026-10-25-chain.md"]) files.set(f, `# ${f}`);
  synthesizeRules.mockReset().mockResolvedValue({ topic: "ai", rules: ["r"] });
});

describe("synthesizeTopic", () => {
  // Regression: review finding on PR #155 — the tag matched as a substring anywhere in a row
  // protects: rules come only from captures tagged exactly with the tag (any case); fails_when: "ai" pulls in "email" or "openai" rows; no_claim: the synthesis prompt
  it("reads only the captures whose tags include the tag exactly", async () => {
    await synthesizeTopic("k", "t", "o/r", "ai", INDEX);
    const contents = synthesizeRules.mock.calls[0]![2] as string[];
    expect(contents).toEqual(["# applied/2026-10-27-agent-loops.md", "# archived/2026-10-26-paint.md"]);
  });

  // protects: a tag nothing carries makes no rules and no model call; fails_when: a substring match still calls the model; no_claim: none
  it("makes no rules when no capture carries the tag", async () => {
    const result = await synthesizeTopic("k", "t", "o/r", "mail", INDEX);
    expect(result.rules).toEqual([]);
    expect(synthesizeRules).not.toHaveBeenCalled();
  });
});
