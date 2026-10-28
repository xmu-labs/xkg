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

  it("gives setup commands the published CLI actually has", () => {
    const commands = [...SERVER_INSTRUCTIONS.matchAll(/npx -y @xmu-labs\/xkg@latest ([a-z-]+)/g)].map((m) => m[1]!);
    expect(commands).toEqual(expect.arrayContaining(["setup-git-hook", "setup-hooks"]));
    for (const cmd of commands) expect(cliSource).toContain(`command === "${cmd}"`);
  });

  it("has the agent ask the user before changing their machine", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/ask the user first/i);
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
});
