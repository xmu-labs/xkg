import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import {
  parsePlanFilenames,
  latestPlanFilename,
  parseChecklist,
  buildAgentBranch,
  withPlanExcludes,
  excludePlanFiles,
  PLAN_FILE,
  AGENT_PROMPT,
} from "../agent.js";

const LIST_PLANS = `3 plan(s):

- **2026-06-03-plan-error-handling.md**: Implementation Plan: Error Handling
- **2026-06-05-plan-provider-abstraction.md**: Implementation Plan: Provider Abstraction
- **2026-06-04-plan-vault.md**: Implementation Plan: Vault`;

describe("parsePlanFilenames", () => {
  it("extracts all bolded plan filenames", () => {
    expect(parsePlanFilenames(LIST_PLANS)).toEqual([
      "2026-06-03-plan-error-handling.md",
      "2026-06-05-plan-provider-abstraction.md",
      "2026-06-04-plan-vault.md",
    ]);
  });

  it("returns empty array when there are no plans", () => {
    expect(parsePlanFilenames("No plans saved yet.")).toEqual([]);
  });
});

describe("latestPlanFilename", () => {
  it("returns the newest plan by date prefix", () => {
    expect(latestPlanFilename(LIST_PLANS)).toBe("2026-06-05-plan-provider-abstraction.md");
  });

  it("returns null when there are no plans", () => {
    expect(latestPlanFilename("No plans saved yet.")).toBeNull();
  });
});

describe("parseChecklist", () => {
  const PLAN = `# Implementation Plan: Foo

## Codebase Mapping
| File | Capture | Change | Complexity | Effort |
|------|---------|--------|------------|--------|
| a.ts | x | edit | simple | low |

## Verification Checklist
- [ ] Error messages include a handler prefix
- [ ] No regressions in the happy path
- [x] Already-done item still counts

## Notes
Not part of the checklist.`;

  it("extracts checklist items without the checkbox prefix", () => {
    expect(parseChecklist(PLAN)).toEqual([
      "Error messages include a handler prefix",
      "No regressions in the happy path",
      "Already-done item still counts",
    ]);
  });

  it("stops at the next section heading", () => {
    expect(parseChecklist(PLAN)).not.toContain("Not part of the checklist.");
  });

  it("returns empty array when there is no checklist section", () => {
    expect(parseChecklist("# Plan\n\n## Context\nNothing here.")).toEqual([]);
  });
});

describe("buildAgentBranch", () => {
  it("produces a deterministic, sortable branch name from a date", () => {
    const branch = buildAgentBranch(new Date("2026-06-05T10:30:45.000Z"));
    expect(branch).toBe("xkg/agent-2026-06-05-10-30-45");
  });

  it("always starts with the xkg/agent- prefix", () => {
    expect(buildAgentBranch()).toMatch(/^xkg\/agent-/);
  });
});

describe("withPlanExcludes", () => {
  it("adds the plan file and the legacy name to an empty exclude file", () => {
    expect(withPlanExcludes("")).toBe("XKG_PLAN.md\nMNEMOS_PLAN.md\n");
  });

  it("appends on a new line when the file lacks a trailing newline", () => {
    expect(withPlanExcludes("*.swp")).toBe("*.swp\nXKG_PLAN.md\nMNEMOS_PLAN.md\n");
  });

  it("only adds what is missing", () => {
    expect(withPlanExcludes("MNEMOS_PLAN.md\n")).toBe("MNEMOS_PLAN.md\nXKG_PLAN.md\n");
  });

  it("returns null when both names are already excluded, anchored or not", () => {
    expect(withPlanExcludes("/XKG_PLAN.md\nMNEMOS_PLAN.md\n")).toBeNull();
  });

  it("does not treat a longer name containing the plan name as a match", () => {
    expect(withPlanExcludes("OLD_XKG_PLAN.md\nMNEMOS_PLAN.md\n")).toBe(
      "OLD_XKG_PLAN.md\nMNEMOS_PLAN.md\nXKG_PLAN.md\n",
    );
  });
});

describe("excludePlanFiles", () => {
  let dir: string;
  const git = (cmd: string, cwd = dir) =>
    execSync(`git ${cmd}`, { cwd, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "xkg-agent-"));
    git("init -q -b main repo");
    const repo = join(dir, "repo");
    git("-c user.name=t -c user.email=t@t commit -q --allow-empty -m init", repo);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps the plan untracked in a worktree of a normal repository", () => {
    const repo = join(dir, "repo");
    const wt = join(dir, "wt");
    git(`worktree add -q -b xkg/agent-test "${wt}"`, repo);
    excludePlanFiles(wt);
    writeFileSync(join(wt, PLAN_FILE), "secret plan");
    git("add -A", wt);
    expect(git("status --porcelain", wt)).toBe("");
  });

  // The old code wrote to <root>/.git/info/exclude, which does not exist when
  // <root> is itself a linked worktree (.git is a file). The plan got committed.
  it("keeps the plan untracked when the agent runs from a linked worktree", () => {
    const repo = join(dir, "repo");
    const outer = join(dir, "outer");
    const wt = join(dir, "wt");
    git(`worktree add -q -b outer "${outer}"`, repo);
    git(`worktree add -q -b xkg/agent-test "${wt}"`, outer);
    excludePlanFiles(wt);
    writeFileSync(join(wt, PLAN_FILE), "secret plan");
    git("add -A", wt);
    expect(git("status --porcelain", wt)).toBe("");
    expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf-8")).toContain(PLAN_FILE);
  });

  it("is idempotent", () => {
    const repo = join(dir, "repo");
    excludePlanFiles(repo);
    excludePlanFiles(repo);
    const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf-8");
    expect(exclude.split("\n").filter((l) => l === PLAN_FILE)).toHaveLength(1);
  });

  it("throws instead of continuing when the plan would still be tracked", () => {
    const repo = join(dir, "repo");
    writeFileSync(join(repo, PLAN_FILE), "already committed");
    git(`add ${PLAN_FILE}`, repo);
    git("-c user.name=t -c user.email=t@t commit -q -m oops", repo);
    expect(() => excludePlanFiles(repo)).toThrow(/would track/);
  });
});

describe("AGENT_PROMPT", () => {
  it("points the agent at the plan file and forbids committing it", () => {
    expect(AGENT_PROMPT).toContain(PLAN_FILE);
    expect(AGENT_PROMPT).toMatch(/never commit/);
  });
});
