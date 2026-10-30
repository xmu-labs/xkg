import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { SERVER_INSTRUCTIONS } from "@/lib/mcp/instructions";
import { TOOLS } from "@/lib/mcp/tools";

/**
 * The instructions an MCP client adds to its agent's system prompt when it
 * connects. They replace the standing instruction users used to paste into
 * each tool by hand, so they must name real tools and real CLI commands.
 */

const toolNames = new Set<string>(TOOLS.map((t) => t.name));
const cliSource = readFileSync(join(process.cwd(), "cli/index.ts"), "utf-8");

describe("MCP server instructions", () => {
  it("names only tools the server has", () => {
    const named = [...SERVER_INSTRUCTIONS.matchAll(/`([a-z]+(?:_[a-z]+)*)`/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) expect(toolNames).toContain(name);
  });

  it("tells the agent when to brief, capture and record an apply", () => {
    for (const tool of ["briefing", "capture", "apply_capture"]) {
      expect(SERVER_INSTRUCTIONS).toContain(`\`${tool}\``);
    }
    expect(SERVER_INSTRUCTIONS).toContain("xkg-capture:");
  });

  it("puts the trailer in the commit itself, since the git hook reads it at commit time", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/when you commit[^.]*include[^.]*xkg-capture:/i);
    expect(SERVER_INSTRUCTIONS).not.toMatch(/after you commit[^.]*add a line/i);
  });

  it("gives setup commands the published CLI actually has", () => {
    const commands = [...SERVER_INSTRUCTIONS.matchAll(/npx -y @xmu-labs\/xkg@latest ([a-z-]+)/g)].map((m) => m[1]!);
    expect(commands).toEqual(expect.arrayContaining(["setup-git-hook", "init"]));
    for (const cmd of commands) expect(cliSource).toContain(`command === "${cmd}"`);
  });

  // protects: setup works the same for every coding agent; fails_when: a setup step is for one agent only; no_claim: init supports every agent
  it("sends the user to init for the session-start hook instead of a Claude-only command", () => {
    expect(SERVER_INSTRUCTIONS).not.toMatch(/Claude Code only/i);
    expect(SERVER_INSTRUCTIONS).not.toContain("setup-hooks");
    expect(SERVER_INSTRUCTIONS).toMatch(/run `npx -y @xmu-labs\/xkg@latest init` in their own terminal/);
  });

  it("has the agent check briefing candidates against the code, since xkg never sees it", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/check each candidate against the code/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/never name a file you have not opened/i);
    expect(SERVER_INSTRUCTIONS).toContain("call `search` with no query");
  });

  // protects: mid-task lookups go through a listed tool; fails_when: the instructions send the agent to recall or another hidden name; no_claim: agents follow it
  it("has the agent call briefing with a task mid-task", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/Mid-task, call `briefing` with task/);
  });

  it("has the agent ask the user before changing their machine", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/ask the user first/i);
  });

  // protects: the session-start offer reaches agents that call briefing themselves; fails_when: the instructions don't pass the repo or don't say to ask the question; no_claim: agents follow it
  it("has the agent pass the repo to briefing and ask the question it gives", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/call `briefing` with repo set to the origin's owner\/name/);
    expect(SERVER_INSTRUCTIONS).toMatch(/starts with captures waiting, ask the user the question it gives/i);
  });

  // protects: answers reach xkg from agents that only read the instructions; fails_when: a refusal isn't recorded, or reads as an apply; no_claim: agents follow it
  it("has the agent record a turned-down capture as declined or later", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/call `apply_capture` with the filename, the commit sha, the repo, and one line on why/);
    expect(SERVER_INSTRUCTIONS).toMatch(/turns a capture down[^.]*outcome declined[^.]*later/);
  });

  it("stays short enough to sit in every agent's system prompt", () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(2000);
  });
});

describe("briefing tool description", () => {
  it("says when to call it, for clients that ignore server instructions", () => {
    const briefing = TOOLS.find((t) => t.name === "briefing")!;
    expect(briefing.description).toMatch(/start of a coding session/i);
  });

  it("says it returns candidates the agent must check against the code", () => {
    const briefing = TOOLS.find((t) => t.name === "briefing")!;
    expect(briefing.description).toMatch(/candidates/i);
    expect(briefing.description).toMatch(/check[^.]*against the code/i);
  });
});

describe("briefing tool schema", () => {
  // protects: a session-start hook can ask for the offer alone; fails_when: briefing has no repo argument or still requires project_context; no_claim: none
  it("takes an optional repo and no longer requires project_context", () => {
    const briefing = TOOLS.find((t) => t.name === "briefing")!;
    const schema = briefing.inputSchema as { properties: Record<string, unknown>; required?: string[] };
    expect(schema.properties).toHaveProperty("repo");
    expect(schema.required ?? []).not.toContain("project_context");
  });
});

describe("apply_capture tool schema", () => {
  const apply = TOOLS.find((t) => t.name === "apply_capture")!;
  const schema = apply.inputSchema as unknown as {
    properties: Record<string, { type: string; description: string; enum?: readonly string[]; items?: { type: string } }>;
    required?: readonly string[];
  };

  // protects: every answer to "Apply this now?" has a field, with fixed values; fails_when: an outcome, reason or confidence value is missing or free text; no_claim: none
  it("takes the outcome, repo, reason, confidence and changed files", () => {
    expect(schema.properties.outcome!.description).toMatch(/applied[\s\S]*declined[\s\S]*done[\s\S]*later[\s\S]*reverted/);
    expect(schema.properties.repo!.type).toBe("string");
    expect(schema.properties.reason!.enum).toEqual(["wrong-files", "doesnt-fit", "other"]);
    expect(schema.properties.confidence!.enum).toEqual(["high", "medium", "low"]);
    expect(schema.properties.files).toMatchObject({ type: "array", items: { type: "string" } });
    expect(schema.required).toEqual(["filename"]);
  });

  // protects: AC1, no field can carry the spec, code or a diff; fails_when: one is added; no_claim: what an agent puts in a short note
  it("has no field for a spec, code or a diff", () => {
    expect(Object.keys(schema.properties).filter((k) => /spec|code|diff|patch|content|body/i.test(k))).toEqual([]);
  });

  // protects: a refusal is never recorded as an apply by an agent that reads only the tool list; fails_when: the description doesn't say so; no_claim: none
  it("says a refusal isn't an apply", () => {
    expect(apply.description).toMatch(/declined[^.]*never counts? as an apply/i);
  });
});
