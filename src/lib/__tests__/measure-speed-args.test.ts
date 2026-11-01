import { describe, it, expect } from "vitest";
import { parseMeasureArgs, MEASURE_HELP } from "../measure-speed-args";

/**
 * The measuring script spends the operator's own API credit, so its arguments
 * are checked before any call: usage errors exit 2 with a line that says what
 * to do, and key values are never printed (only the variable names).
 */

const env = { OPENAI_API_KEY: "sk-secret-value" };

describe("parseMeasureArgs", () => {
  // protects: a plain run reads the sources and measures every provider with a key; fails_when: defaults change silently; no_claim: none
  it("defaults to the providers that have a key, one run per source", () => {
    expect(parseMeasureArgs(["--sources", "/tmp/s"], env)).toEqual({
      ok: true,
      opts: { sources: "/tmp/s", providers: ["openai"], out: null, runs: 1, verbose: false, yes: false },
    });
  });

  // protects: --help never spends anything; fails_when: help is treated as a run; no_claim: none
  it("prints help", () => {
    expect(parseMeasureArgs(["--help"], {})).toEqual({ ok: false, exit: 0, message: MEASURE_HELP });
  });

  // protects: a run without sources fails before any call; fails_when: it starts anyway; no_claim: none
  it("needs --sources", () => {
    const r = parseMeasureArgs([], env);
    expect(r).toMatchObject({ ok: false, exit: 2 });
    expect(!r.ok && r.message).toMatch(/--sources <dir>/);
  });

  // protects: a missing key names the variable and the way around it, never a value; fails_when: the message lacks the fix or leaks a key; no_claim: none
  it("names the missing key variable and how to skip that provider", () => {
    const r = parseMeasureArgs(["--sources", "/tmp/s", "--providers", "openai,anthropic"], env);
    expect(r).toEqual({
      ok: false, exit: 2,
      message: "measure-model-speed: no key for anthropic (ANTHROPIC_API_KEY is unset). Export it, or pass --providers openai to skip it.",
    });
    expect(JSON.stringify(r)).not.toContain("sk-secret-value");
  });

  // protects: with no keys at all the script says which variables it reads; fails_when: it runs with nothing to measure; no_claim: none
  it("refuses to run with no keys", () => {
    const r = parseMeasureArgs(["--sources", "/tmp/s"], {});
    expect(r).toMatchObject({ ok: false, exit: 2 });
    expect(!r.ok && r.message).toContain("OPENAI_API_KEY, ANTHROPIC_API_KEY or GEMINI_API_KEY");
  });

  // protects: typos fail loudly; fails_when: an unknown provider, flag or bad --runs is ignored; no_claim: none
  it.each([
    [["--sources", "/s", "--providers", "openia"], /Unknown provider "openia"/],
    [["--sources", "/s", "--runs", "0"], /--runs must be a whole number from 1 to 10/],
    [["--sources", "/s", "--frobnicate"], /Unknown option "--frobnicate"/],
  ])("rejects %j", (argv, msg) => {
    const r = parseMeasureArgs(argv, env);
    expect(r).toMatchObject({ ok: false, exit: 2 });
    expect(!r.ok && r.message).toMatch(msg);
  });

  // protects: every flag is read; fails_when: one is dropped; no_claim: none
  it("reads every flag", () => {
    expect(parseMeasureArgs(["--sources", "/s", "--providers", "openai", "--out", "o.json", "--runs", "3", "--verbose", "--yes"], env)).toEqual({
      ok: true, opts: { sources: "/s", providers: ["openai"], out: "o.json", runs: 3, verbose: true, yes: true },
    });
  });
});
