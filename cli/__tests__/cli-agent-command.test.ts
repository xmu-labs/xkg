import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * `xkg agent` runs a saved plan with the user's own coding agent. It used to be
 * called `xkg kos`; the old name still works for now and says it was renamed.
 */

const runAgent = vi.fn(async () => {});
vi.mock("../agent.js", async (orig) => ({ ...(await orig<typeof import("../agent.js")>()), runAgent: (...a: unknown[]) => runAgent(...(a as [])) }));
vi.mock("../config.js", () => ({ readConfig: () => ({}) }));

let logs: string[] = [];
let errors: string[] = [];
const argv = process.argv;

async function cli(...args: string[]) {
  process.argv = ["node", "xkg", ...args];
  vi.resetModules();
  await import("../index.js");
  // main() runs on import; let it finish.
  await new Promise((r) => setTimeout(r, 20));
}

beforeEach(() => {
  runAgent.mockClear();
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errors.push(a.join(" ")); });
});
afterEach(() => {
  process.argv = argv;
  vi.restoreAllMocks();
});

describe("xkg agent", () => {
  // protects: AC1, the new name runs the plan exactly as kos did; fails_when: `agent` falls through to opening the browser or drops --plan; no_claim: what the agent does (agent.test.ts)
  it("runs the plan with the given key and plan file", async () => {
    await cli("agent", "--key", "k1", "--plan", "2026-06-05-plan-x.md");
    expect(runAgent).toHaveBeenCalledWith("k1", { plan: "2026-06-05-plan-x.md" });
    expect(errors).toEqual([]);
  });

  // protects: AC2, the old name still works and says it was renamed; fails_when: `kos` stops working or runs silently; no_claim: when the alias is removed
  it("still runs under the old name kos, with a one-line note", async () => {
    await cli("kos", "--key", "k1");
    expect(runAgent).toHaveBeenCalledWith("k1", { plan: undefined });
    expect(errors).toEqual(["`xkg kos` is now `xkg agent`. The old name will stop working in a later release."]);
  });

  // protects: a local handoff spec runs without a key, since nothing is fetched from xkg; fails_when: --spec is dropped or a key is demanded; no_claim: the run (agent.test.ts)
  it("runs a local spec with --spec, no key needed", async () => {
    await cli("agent", "--spec", ".xkg/handoffs/2026-10-28-llm-memory.md");
    expect(runAgent).toHaveBeenCalledWith("", { plan: undefined, spec: ".xkg/handoffs/2026-10-28-llm-memory.md" });
    expect(errors).toEqual([]);
    await cli("help");
    expect(logs.join("\n")).toContain("xkg agent --spec PATH");
  });

  // protects: AC3, help names the new command only; fails_when: help still says kos; no_claim: the rest of the help text
  it("is what help shows", async () => {
    await cli("help");
    const help = logs.join("\n");
    expect(help).toContain("xkg agent --key KEY [--plan FILE]");
    expect(help).not.toMatch(/\bkos\b/);
  });
});
