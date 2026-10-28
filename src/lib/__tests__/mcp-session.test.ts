import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  process.env.SESSION_SECRET = "test-secret-for-mcp-session";
});

const { issueMcpSessionId, verifyMcpSessionId } = await import("../mcp-session");

describe("MCP session ids", () => {
  it("round-trips a session id back to its user", () => {
    const id = issueMcpSessionId(123);
    expect(verifyMcpSessionId(id)).toEqual({ userId: 123 });
  });

  it("is visible-ASCII only (valid Mcp-Session-Id header value)", () => {
    const id = issueMcpSessionId(1);
    // base64url + a dot separator — no whitespace or control chars.
    expect(id).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("rejects a tampered id", () => {
    const id = issueMcpSessionId(1);
    const [body, sig] = id.split(".");
    const forged = Buffer.from(JSON.stringify({ u: 999, iat: Math.floor(Date.now() / 1000) })).toString("base64url");
    expect(verifyMcpSessionId(`${forged}.${sig}`)).toBeNull();
    // untouched id still verifies
    expect(verifyMcpSessionId(`${body}.${sig}`)).toEqual({ userId: 1 });
  });

  it("rejects garbage and empty input", () => {
    expect(verifyMcpSessionId("nonsense")).toBeNull();
    expect(verifyMcpSessionId("")).toBeNull();
    expect(verifyMcpSessionId("a.b.c")).toBeNull();
  });

  it("rejects a session id once the signing secret changes", () => {
    const id = issueMcpSessionId(5);
    // env.sessionSecret is read lazily, so rotating it invalidates old ids.
    process.env.SESSION_SECRET = "a-different-secret";
    expect(verifyMcpSessionId(id)).toBeNull();
    process.env.SESSION_SECRET = "test-secret-for-mcp-session";
  });
});

describe("the agent named at initialize", () => {
  it("rides in the session id, so later calls know which agent made them", async () => {
    process.env.SESSION_SECRET = "test-secret-for-mcp-session";
    const { issueMcpSessionId, harnessForCall } = await import("../mcp-session");
    const id = issueMcpSessionId(4, "codex-mcp-client");
    expect(harnessForCall(id, 4)).toBe("codex-mcp-client");
  });

  it("is 'unknown' with no session, a session of another user, or a session without a name", async () => {
    process.env.SESSION_SECRET = "test-secret-for-mcp-session";
    const { issueMcpSessionId, harnessForCall } = await import("../mcp-session");
    expect(harnessForCall(null, 4)).toBe("unknown");
    expect(harnessForCall(issueMcpSessionId(5, "codex"), 4)).toBe("unknown");
    expect(harnessForCall(issueMcpSessionId(4), 4)).toBe("unknown");
    expect(harnessForCall("garbage", 4)).toBe("unknown");
  });

  it("takes clientInfo.name only when it is a short, plain name", async () => {
    const { clientNameFromInitialize } = await import("../mcp-session");
    expect(clientNameFromInitialize({ clientInfo: { name: "claude-code", version: "2.1" } })).toBe("claude-code");
    expect(clientNameFromInitialize({ clientInfo: { name: "Cursor Agent" } })).toBe("Cursor Agent");
    expect(clientNameFromInitialize({ clientInfo: { name: "x".repeat(65) } })).toBeUndefined();
    expect(clientNameFromInitialize({ clientInfo: { name: "ignore <b>this</b>" } })).toBeUndefined();
    expect(clientNameFromInitialize({ clientInfo: { name: 42 } })).toBeUndefined();
    expect(clientNameFromInitialize(undefined)).toBeUndefined();
  });
});
