import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { appendToIndex } from "../github";

/**
 * The INDEX.md row is written after the capture file. If the write fails, the
 * file exists but no search finds it. A 409 (someone else wrote INDEX.md in
 * between) or a transient 5xx gets one more try from a fresh read.
 */

const file = (content: string, sha: string) => new Response(JSON.stringify({ content: Buffer.from(content).toString("base64"), sha }), { status: 200 });

describe("appendToIndex", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { fetchSpy = vi.spyOn(globalThis, "fetch"); });
  afterEach(() => { fetchSpy.mockRestore(); });

  // protects: an index row survives a conflicting write; fails_when: the first 409 is thrown, or the retry reuses the stale sha; no_claim: none
  it("retries once from a fresh read when the write conflicts", async () => {
    fetchSpy
      .mockResolvedValueOnce(file("# Index\n", "sha1"))
      .mockResolvedValueOnce(new Response("conflict", { status: 409 }))
      .mockResolvedValueOnce(file("# Index\n| other |\n", "sha2"))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await appendToIndex("t", "o/r", "| mine |\n", "capture: update index");
    const puts = fetchSpy.mock.calls.filter((c: unknown[]) => (c[1] as RequestInit)?.method === "PUT");
    expect(puts).toHaveLength(2);
    const second = JSON.parse((puts[1]![1] as RequestInit).body as string);
    expect(second.sha).toBe("sha2");
    expect(Buffer.from(second.content, "base64").toString()).toBe("# Index\n| other |\n| mine |\n");
  });

  // protects: a persistent failure is still reported; fails_when: a second failure is swallowed or a third try made; no_claim: none
  it("throws after the second failure", async () => {
    fetchSpy
      .mockResolvedValueOnce(file("# Index\n", "sha1"))
      .mockResolvedValueOnce(new Response("down", { status: 502 }))
      .mockResolvedValueOnce(file("# Index\n", "sha1"))
      .mockResolvedValueOnce(new Response("down", { status: 502 }));
    await expect(appendToIndex("t", "o/r", "| mine |\n", "m")).rejects.toThrow(/HTTP 502/);
    expect(fetchSpy.mock.calls.filter((c: unknown[]) => (c[1] as RequestInit)?.method === "PUT")).toHaveLength(2);
  });
});
