import { describe, expect, it } from "vitest";
import { captureFileUrl } from "../captureFileUrl";

describe("captureFileUrl", () => {
  it("points at the capture in the repo's default branch", () => {
    expect(captureFileUrl("ola/xkg-knowledge", "2026-10-24-rag.md")).toBe(
      "https://github.com/ola/xkg-knowledge/blob/HEAD/inbox/2026-10-24-rag.md",
    );
  });
  it("encodes characters a filename could carry", () => {
    expect(captureFileUrl("ola/k", "a b#c.md")).toBe("https://github.com/ola/k/blob/HEAD/inbox/a%20b%23c.md");
  });
});
