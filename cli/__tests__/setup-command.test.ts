import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { browserCommand, isGitRepo, parseInitArgs, previewSessionStart } from "../setup-command.js";

const sessionStart = vi.fn(async (_key: string, _opts: Record<string, unknown>) => { process.stdout.write("xkg: 2 new captures\n"); });
vi.mock("../session-start.js", () => ({ sessionStart: (k: string, o: Record<string, unknown>) => sessionStart(k, o) }));

describe("previewSessionStart", () => {
  it("shows the inbox offer without asking for this repo's handoffs, which would count as an offer", async () => {
    const text = await previewSessionStart("k");
    expect(text).toBe("xkg: 2 new captures\n");
    expect(sessionStart).toHaveBeenCalledWith("k", { repo: null });
  });
});

describe("browserCommand", () => {
  it("opens a URL with the platform's own opener", () => {
    expect(browserCommand("darwin", "https://x.test/a")).toEqual(["open", ["https://x.test/a"]]);
    expect(browserCommand("linux", "https://x.test/a")).toEqual(["xdg-open", ["https://x.test/a"]]);
    expect(browserCommand("win32", "https://x.test/a?b=1&c=2")).toEqual(["rundll32", ["url.dll,FileProtocolHandler", "https://x.test/a?b=1&c=2"]]);
  });
});

describe("isGitRepo", () => {
  it("is true in a git repo with no origin remote, and false outside one", () => {
    const dir = mkdtempSync(join(tmpdir(), "xkg-git-"));
    try {
      expect(isGitRepo(dir)).toBe(false);
      execFileSync("git", ["init", "-q"], { cwd: dir });
      expect(isGitRepo(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
