import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseInitArgs } from "../setup-command.js";

describe("parseInitArgs", () => {
  it("reads --key, --yes and --agents", () => {
    expect(parseInitArgs(["--key", "k", "--yes", "--agents", "codex,cursor"])).toEqual({ key: "k", yes: true, only: ["codex", "cursor"] });
  });

  it("defaults to asking, for every agent found", () => {
    expect(parseInitArgs([])).toEqual({ key: undefined, yes: false, only: undefined });
  });

  it("accepts -y", () => {
    expect(parseInitArgs(["-y"]).yes).toBe(true);
  });

  it("rejects an agent name it doesn't know", () => {
    expect(() => parseInitArgs(["--agents", "codex,vim"])).toThrow(/vim/);
  });
});

describe("xkg help", () => {
  const argv = process.argv;
  let logs: string[] = [];
  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
  });
  afterEach(() => {
    process.argv = argv;
    vi.restoreAllMocks();
  });

  it("lists init and doctor", async () => {
    process.argv = ["node", "xkg", "help"];
    vi.resetModules();
    await import("../index.js");
    await new Promise((r) => setTimeout(r, 20));
    const help = logs.join("\n");
    expect(help).toContain("xkg init");
    expect(help).toContain("xkg doctor");
  });
});
