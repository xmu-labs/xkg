import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as { bin: Record<string, string> };

describe("package.json bin", () => {
  it("installs the xkg command", () => {
    expect(pkg.bin.xkg).toBe("dist/cli/index.js");
  });

  it("does not install an xmu command, which belongs to the separate xmu CLI", () => {
    expect(pkg.bin).not.toHaveProperty("xmu");
  });

  it("installs only xkg: mnemos-capture is a retired package name, not a command of this one", () => {
    expect(Object.keys(pkg.bin)).toEqual(["xkg"]);
  });
});
