import { describe, it, expect } from "vitest";

describe("upgradeArgs", () => {
  // protects: serve-mcp's self-upgrade in a clone of xkg itself runs the published release; fails_when: the respawn starts npx with the clone as its project, so at the same version it runs the clone's unbuilt bin and the MCP server exits; no_claim: npm's own package resolution (checked by hand with real npx)
  it("respawns the release under its own name, with an npx project outside the current repo", async () => {
    const { upgradeArgs } = await import("../version-check.js");
    expect(upgradeArgs("mnemos-capture", "1.9.0", ["serve-mcp", "--key", "k"], "/home/u")).toEqual([
      "--prefix", "/home/u", "-y", "mnemos-capture@1.9.0", "serve-mcp", "--key", "k",
    ]);
  });
});
