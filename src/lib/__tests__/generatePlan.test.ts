import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreate = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
}));

const { generatePlan } = await import("../llm");

const MOCK_PLAN = `# Implementation Plan: Error Handling Improvements

## Context
Applying error observability insights to the capture pipeline.

## Captures Being Applied
- **error-context-first** — Add source context to every error message.

## Codebase Mapping
| File | Capture | Change |
|------|---------|--------|
| src/app/api/capture/route.ts | error-context-first | Prefix all errors with handler name |

## Implementation Steps
### 1. src/app/api/capture/route.ts
**Capture:** error-context-first
**Change:** Wrap catch blocks to prefix messages
**Why:** Opaque errors caused 3 misdiagnoses in the last sprint.

## Verification Checklist
- [ ] Error messages include handler prefix
- [ ] No regressions in happy path`;

describe("generatePlan", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: MOCK_PLAN }] });
  });

  it("returns the LLM-generated plan text", async () => {
    const result = await generatePlan(
      "test-key",
      [{ filename: "inbox/2026-05-01-error-context-first.md", content: "## Core idea\nAdd context." }],
      "Project: xkg, Branch: feature/errors",
    );
    expect(result).toBe(MOCK_PLAN);
  });

  it("includes each selected capture in the LLM message", async () => {
    await generatePlan(
      "test-key",
      [
        { filename: "inbox/capture-a.md", content: "Content A" },
        { filename: "inbox/capture-b.md", content: "Content B" },
      ],
      "Project context here",
    );

    const callArgs = mockCreate.mock.calls[0]?.[0] as { messages: Array<{ content: string }> };
    const userContent = callArgs.messages[0]?.content ?? "";
    expect(userContent).toContain("inbox/capture-a.md");
    expect(userContent).toContain("Content A");
    expect(userContent).toContain("inbox/capture-b.md");
    expect(userContent).toContain("Content B");
  });

  it("includes project context in the LLM message", async () => {
    await generatePlan(
      "test-key",
      [{ filename: "inbox/x.md", content: "x" }],
      "Branch: feature/retry, Project: my-app",
    );

    const callArgs = mockCreate.mock.calls[0]?.[0] as { messages: Array<{ content: string }> };
    const userContent = callArgs.messages[0]?.content ?? "";
    expect(userContent).toContain("Branch: feature/retry");
  });

  it("includes codebase files in the LLM message when provided", async () => {
    await generatePlan(
      "test-key",
      [{ filename: "inbox/x.md", content: "x" }],
      "context",
      [{ path: "src/lib/llm.ts", content: "export function foo() {}" }],
    );

    const callArgs = mockCreate.mock.calls[0]?.[0] as { messages: Array<{ content: string }> };
    const userContent = callArgs.messages[0]?.content ?? "";
    expect(userContent).toContain("src/lib/llm.ts");
    expect(userContent).toContain("export function foo()");
  });

  it("truncates codebase file content at 4000 chars", async () => {
    const longContent = "x".repeat(5000);
    await generatePlan(
      "test-key",
      [{ filename: "inbox/x.md", content: "x" }],
      "context",
      [{ path: "big.ts", content: longContent }],
    );

    const callArgs = mockCreate.mock.calls[0]?.[0] as { messages: Array<{ content: string }> };
    const userContent = callArgs.messages[0]?.content ?? "";
    expect(userContent).toContain("[truncated]");
    expect(userContent).not.toContain("x".repeat(5000));
  });

  it("uses max_tokens: 3000 for the LLM call", async () => {
    await generatePlan("test-key", [{ filename: "inbox/x.md", content: "x" }], "context");

    const callArgs = mockCreate.mock.calls[0]?.[0] as { max_tokens: number };
    expect(callArgs.max_tokens).toBe(3000);
  });

  it("returns fallback text when Anthropic returns no content", async () => {
    mockCreate.mockResolvedValue({ content: [] });

    const result = await generatePlan("test-key", [{ filename: "inbox/x.md", content: "x" }], "context");
    expect(result).toContain("could not be generated");
  });
});
