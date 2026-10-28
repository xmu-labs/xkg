import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchSourceContent } from "../fetch-source";
import { buildSource } from "../evidence";
import { MAX_INPUT_CHARS } from "../llm";

/**
 * The fetcher must not cut a long page to exactly the extraction limit, or the
 * extraction can't tell the page was cut and the model is never told so.
 */
describe("fetchSourceContent on a page longer than the extraction limit", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns enough text for the extraction to detect truncation", async () => {
    const words = "word ".repeat(MAX_INPUT_CHARS);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(`<html><body><p>${words}</p></body></html>`, {
        status: 200, headers: { "content-type": "text/html" },
      }),
    );
    const text = await fetchSourceContent("https://example.com/long");
    expect(text).not.toBeNull();
    expect(buildSource(text!, { maxChars: MAX_INPUT_CHARS }).truncated).toBe(true);
  });
});
