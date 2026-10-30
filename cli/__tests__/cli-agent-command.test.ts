import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * `xkg agent` runs a saved plan with the user's own coding agent.
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
  // main() runs on import; give it a moment. Tests that expect a call wait for it,
  // since under load the dynamic imports in main() can take longer than this.
  await new Promise((r) => setTimeout(r, 0));
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
  // protects: the command runs the plan; fails_when: `agent` falls through to opening the browser or drops --plan; no_claim: what the agent does (agent.test.ts)
  it("runs the plan with the given key and plan file", async () => {
    await cli("agent", "--key", "k1", "--plan", "2026-06-05-plan-x.md");
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledWith("k1", { plan: "2026-06-05-plan-x.md" }));
    expect(errors).toEqual([]);
  });

  // protects: the old name kos is gone; fails_when: `kos` still runs the agent; no_claim: what an unknown command prints
  it("no longer runs under the old name kos", async () => {
    await cli("kos", "--key", "k1");
    expect(runAgent).not.toHaveBeenCalled();
  });

  // protects: a local handoff spec runs without a key, since nothing is fetched from xkg; fails_when: --spec is dropped or a key is demanded; no_claim: the run (agent.test.ts)
  it("runs a local spec with --spec, no key needed", async () => {
    await cli("agent", "--spec", ".xkg/handoffs/2026-10-28-llm-memory.md");
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledWith("", { plan: undefined, spec: ".xkg/handoffs/2026-10-28-llm-memory.md" }));
    expect(errors).toEqual([]);
    await cli("help");
    expect(logs.join("\n")).toContain("xkg agent --spec PATH");
  });

  // protects: help names the command; fails_when: help still says kos; no_claim: the rest of the help text
  it("is what help shows", async () => {
    await cli("help");
    const help = logs.join("\n");
    expect(help).toContain("xkg agent --key KEY --plan FILE");
    expect(help).not.toMatch(/\bkos\b/);
  });
});
