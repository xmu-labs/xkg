import { describe, it, expect } from "vitest";
import { stepTimer, timingLine, failureLine, errorClass } from "../capture-timing";
import { effortApplied } from "../llm";

/**
 * The timing line is how a slow or failed capture shows up in the logs, and
 * what later decides when to suggest a faster model. It carries counts and
 * classes only: never the capture's name, content, URL or the provider's text.
 */

const stats = { claimsProposed: 5, claimsKept: 3, fieldsTotal: 4 };

describe("timingLine", () => {
  // protects: a finished capture logs its claim counts and that it succeeded; fails_when: ok or a count is missing; no_claim: the counts are right (normalizeCapture's tests)
  it("marks the capture ok and carries its claim counts", () => {
    const timer = stepTimer();
    timer.mark("extract");
    timer.answered();
    const line = timingLine("web", timer, { provider: "openai", model: "gpt-4o-mini", effort: null }, { tokensIn: 10, tokensOut: 20 }, true, { stats });
    expect(line).toMatchObject({ event: "capture.timing", via: "web", ok: true, provider: "openai", model: "gpt-4o-mini", effortApplied: false, fetched: true, tokensIn: 10, tokensOut: 20, ...stats });
    expect(typeof line.ms.extract).toBe("number");
  });

  // protects: a capture without counts still logs; fails_when: the line throws or invents counts; no_claim: none
  it("leaves the counts empty when the capture has none", () => {
    const line = timingLine("mcp", stepTimer(), "anthropic", null, false, {});
    expect(line).toMatchObject({ ok: true, claimsProposed: null, claimsKept: null, fieldsTotal: null });
  });
});

describe("failureLine", () => {
  // protects: a failed extraction leaves a timing line too; fails_when: no ok:false, no class, or the provider's text leaks; no_claim: the class is the root cause
  it("logs ok:false with an error class and never the message", () => {
    const timer = stepTimer();
    timer.mark("extract");
    const line = failureLine("web", timer, { provider: "openai", model: "gpt-6.1-terra", effort: "high" }, null, false, new Error("[llm:openai] HTTP 503 — upstream said something private"));
    expect(line).toMatchObject({ event: "capture.timing", via: "web", ok: false, error: "http_503", provider: "openai", model: "gpt-6.1-terra", effort: "high", effortApplied: true, tokensIn: null, tokensOut: null });
    expect(typeof line.ms.extract).toBe("number");
    expect(JSON.stringify(line)).not.toContain("private");
  });
});

describe("errorClass", () => {
  // protects: failures group into a few classes in the logs; fails_when: a known failure lands in "other"; no_claim: none
  it.each([
    ["[llm] No answer from the provider after 60s.", "timeout"],
    ["Request timed out.", "timeout"],
    ["[llm:openai] HTTP 503 — busy", "http_503"],
    ["[llm:groq] HTTP 429 — slow down", "http_429"],
    ["400 {\"type\":\"error\"}", "http_400"],
    ["Failed to parse LLM response — extraction returned invalid JSON.", "invalid_json"],
    ["something else", "other"],
  ])("%s → %s", (message, cls) => {
    expect(errorClass(new Error(message))).toBe(cls);
  });

  // protects: a thrown non-Error still logs; fails_when: errorClass throws; no_claim: none
  it("calls a non-Error other", () => {
    expect(errorClass("boom")).toBe("other");
  });
});

describe("effortApplied", () => {
  // protects: effort is reported only when the request carried it, so the hint never blames an effort the provider ignored; fails_when: an adapter that drops effort reports true, or one that sends it reports false; no_claim: the provider honored it
  it.each([
    [{ provider: "openai", model: "gpt-6.1-terra", effort: "high" }, true],
    [{ provider: "openai", model: "gpt-4o-mini", effort: "high" }, false],
    [{ provider: "openai", model: "gpt-5", effort: null }, false],
    [{ provider: "anthropic", model: "claude-haiku-4-5", effort: "low" }, true],
    [{ provider: "anthropic", model: "claude-haiku-4-5", effort: null }, false],
    [{ provider: "google", model: "gemini-2.0-flash", effort: "high" }, false],
    [{ provider: "google", model: "gemini-2.5-flash", effort: "medium" }, true],
    [{ provider: "openrouter", model: "x/y", effort: "high" }, true],
    [{ provider: "xai", model: "grok-4", effort: "high" }, false],
    [{ provider: "groq", model: "llama", effort: "high" }, false],
    ["openai", false],
  ] as const)("%j → %s", (llm, expected) => {
    expect(effortApplied(llm as never)).toBe(expected);
  });
});
