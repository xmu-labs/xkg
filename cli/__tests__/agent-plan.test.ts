import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * `xkg agent --plan FILE` reads a saved plan with read_capture, one of the 5
 * listed tools, so it keeps working when the hidden list_plans name goes.
 */

const callMcp = vi.fn();
vi.mock("../hooks.js", () => ({ callMcp: (...a: unknown[]) => callMcp(...a) }));

const { savedPlan } = await import("../agent.js");

let errors: string[] = [];
beforeEach(() => {
  callMcp.mockReset();
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errors.push(a.join(" ")); });
  vi.spyOn(process, "exit").mockImplementation(((code: number) => { throw new Error(`exit ${code}`); }) as never);
});
afterEach(() => vi.restoreAllMocks());

describe("savedPlan", () => {
  // protects: XKG-84, the plan is read through read_capture; fails_when: list_plans is called, or the plans/ folder is dropped; no_claim: the run itself (agent.test.ts)
  it("reads the named plan from plans/ with read_capture", async () => {
    callMcp.mockResolvedValue("# Plan x\n\n## Verification Checklist\n- [ ] works\n");
    await expect(savedPlan("k1", "2026-06-05-plan-x.md")).resolves.toEqual({ file: "2026-06-05-plan-x.md", text: "# Plan x\n\n## Verification Checklist\n- [ ] works\n" });
    expect(callMcp).toHaveBeenCalledWith("k1", "read_capture", { filename: "plans/2026-06-05-plan-x.md" }, 15000);
    expect(callMcp.mock.calls.some((c) => c[1] === "list_plans")).toBe(false);
  });

  // protects: a plan named with its folder still works; fails_when: plans/plans/x.md is asked for; no_claim: none
  it("accepts the name with its plans/ folder", async () => {
    callMcp.mockResolvedValue("# Plan x\n");
    await savedPlan("k1", "plans/2026-06-05-plan-x.md");
    expect(callMcp).toHaveBeenCalledWith("k1", "read_capture", { filename: "plans/2026-06-05-plan-x.md" }, 15000);
  });

  // protects: a wrong name stops with a clear message, not a run on "File not found" text; fails_when: the not-found answer is handed to the agent as the plan; no_claim: none
  it("stops when the plan isn't there", async () => {
    callMcp.mockResolvedValue("File not found: plans/nope.md. Use search to find it.");
    await expect(savedPlan("k1", "nope.md")).rejects.toThrow("exit 1");
    expect(errors.join("\n")).toContain("Could not read plan: nope.md");
  });

  // protects: without a name there is nothing to list with the 5 tools, so it says what to pass; fails_when: list_plans is called or it runs nothing silently; no_claim: none
  it("asks for a plan name when none is given", async () => {
    await expect(savedPlan("k1", undefined)).rejects.toThrow("exit 1");
    expect(callMcp).not.toHaveBeenCalled();
    expect(errors.join("\n")).toContain("xkg agent --plan FILE");
  });
});
