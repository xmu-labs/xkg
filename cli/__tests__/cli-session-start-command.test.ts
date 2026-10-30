import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * `xkg session-start` is the one command every agent's SessionStart hook runs.
 * The key comes from --key or ~/.xkg/config.json, so hook files carry no key.
 */

const sessionStart = vi.fn(async () => {});
vi.mock("../session-start.js", () => ({ sessionStart: (...a: unknown[]) => sessionStart(...(a as [])) }));
let storedKey: string | undefined;
vi.mock("../config.js", () => ({ readConfig: () => ({ key: storedKey }) }));
let hookInput = "";
vi.mock("../hooks.js", () => ({ readStdin: async () => hookInput }));

let logs: string[] = [];
const argv = process.argv;

async function cli(...args: string[]) {
  process.argv = ["node", "xkg", ...args];
  vi.resetModules();
  await import("../index.js");
  // main() runs on import; let it finish.
  await new Promise((r) => setTimeout(r, 20));
}

beforeEach(() => {
  sessionStart.mockClear();
  storedKey = undefined;
  hookInput = "";
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.argv = argv;
  vi.restoreAllMocks();
});

describe("xkg session-start", () => {
  it("uses the stored key and passes the agent name", async () => {
    storedKey = "stored";
    await cli("session-start", "--agent", "cursor");
    expect(sessionStart).toHaveBeenCalledWith("stored", { agent: "cursor", input: "" });
  });

  it("prefers --key over the stored key", async () => {
    storedKey = "stored";
    await cli("session-start", "--key", "k1");
    expect(sessionStart).toHaveBeenCalledWith("k1", { agent: undefined, input: "" });
  });

  // protects: the hook's stdin reaches session-start, so a continued session can be told apart; fails_when: the command drops what the agent sent; no_claim: real pipes (QA)
  it("passes what the agent's hook sent on stdin", async () => {
    storedKey = "stored";
    hookInput = '{"source":"compact"}';
    await cli("session-start", "--agent", "codex");
    expect(sessionStart).toHaveBeenCalledWith("stored", { agent: "codex", input: '{"source":"compact"}' });
  });

  it("does nothing, and doesn't open the browser, without a key", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await cli("session-start", "--agent", "codex");
    expect(sessionStart).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
    expect(logs).toEqual([]);
  });

  it("is in the help", async () => {
    await cli("help");
    expect(logs.join("\n")).toContain("xkg session-start [--agent NAME]");
  });
});
