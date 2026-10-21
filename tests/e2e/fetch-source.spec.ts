import { test, expect } from "@playwright/test";
import { fetchSourceContent } from "../../src/lib/fetch-source";

/**
 * Live-network integration tests for the capture URL-fetch feature.
 *
 * These hit the real network (unlike the vitest unit tests, which only cover
 * the pure helpers). They prove the behavior the feature exists for: a bare URL
 * is turned into real, cleaned page text before it ever reaches the LLM.
 */

// Stable, content-rich, no bot-challenge, allows server-side fetch.
const REAL_ARTICLE = "https://en.wikipedia.org/wiki/Systems_thinking";

test.describe("fetchSourceContent — live network", () => {
  test("extracts clean, real article text from a bare URL", async () => {
    const text = await fetchSourceContent(REAL_ARTICLE);

    expect(text, "should return extracted text, not null").not.toBeNull();
    const content = text!;

    // Real article content actually made it through.
    expect(content.toLowerCase()).toContain("systems thinking");
    expect(content.length).toBeGreaterThan(1000);

    // HTML is fully stripped — no tags, no <script>/<style> leakage.
    expect(content).not.toContain("<");
    expect(content).not.toMatch(/<\s*script/i);
    expect(content).not.toMatch(/function\s*\(/);

    // Capped to the LLM input budget.
    expect(content.length).toBeLessThanOrEqual(6000);
  });

  test("returns null when the host cannot be resolved (DNS failure)", async () => {
    const text = await fetchSourceContent(
      "https://this-domain-definitely-does-not-exist-xkg-987654.example/article",
    );
    expect(text).toBeNull();
  });
});

test.describe("fetchSourceContent — SSRF + input guards (no outbound fetch)", () => {
  test("blocks the cloud metadata endpoint", async () => {
    expect(await fetchSourceContent("http://169.254.169.254/latest/meta-data/")).toBeNull();
  });

  test("blocks localhost", async () => {
    expect(await fetchSourceContent("http://localhost:3000/internal")).toBeNull();
  });

  test("blocks private IPv4 ranges", async () => {
    expect(await fetchSourceContent("http://10.0.0.1/")).toBeNull();
    expect(await fetchSourceContent("http://192.168.1.1/admin")).toBeNull();
  });

  test("rejects non-http(s) protocols", async () => {
    expect(await fetchSourceContent("ftp://example.com/file.txt")).toBeNull();
    expect(await fetchSourceContent("file:///etc/passwd")).toBeNull();
  });

  test("rejects malformed URLs", async () => {
    expect(await fetchSourceContent("not a url")).toBeNull();
  });
});
