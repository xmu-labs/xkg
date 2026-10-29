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
    expect(commands).toEqual(expect.arrayContaining(["setup-git-hook", "setup-hooks"]));
    for (const cmd of commands) expect(cliSource).toContain(`command === "${cmd}"`);
  });

  it("has the agent check briefing candidates against the code, since xkg never sees it", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/check each candidate against the code/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/never name a file you have not opened/i);
    expect(SERVER_INSTRUCTIONS).toContain("call `search_captures` with no query");
  });

  it("has the agent ask the user before changing their machine", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/ask the user first/i);
  });

  // protects: the session-start offer reaches agents that call briefing themselves; fails_when: the instructions don't pass the repo or don't say to ask the question; no_claim: agents follow it
  it("has the agent pass the repo to briefing and ask the question it gives", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/call `briefing` with repo set to the origin's owner\/name/);
    expect(SERVER_INSTRUCTIONS).toMatch(/starts with captures waiting, ask the user the question it gives/i);
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
