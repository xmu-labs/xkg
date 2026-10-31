import { describe, expect, it } from "vitest";
import { captureFileUrl } from "../captureFileUrl";

describe("captureFileUrl", () => {
  it("points at the capture on main, the branch captures are written to", () => {
    expect(captureFileUrl("ola/xkg-knowledge", "2026-10-24-rag.md")).toBe(
      "https://github.com/ola/xkg-knowledge/blob/main/inbox/2026-10-24-rag.md",
    );
  });
  it("encodes characters a filename could carry", () => {
    expect(captureFileUrl("ola/k", "a b#c.md")).toBe("https://github.com/ola/k/blob/main/inbox/a%20b%23c.md");
  });
  it("points into the folder a capture moved to", () => {
    expect(captureFileUrl("ola/k", "2026-10-24-rag.md", "archived")).toBe("https://github.com/ola/k/blob/main/archived/2026-10-24-rag.md");
  });
});
