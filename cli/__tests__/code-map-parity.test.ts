import { describe, it, expect } from "vitest";
import { capMap, SKIP_DIR, SKIP_FILE } from "../code-map";
import { capPaths, SKIP_DIR as SERVER_SKIP_DIR, SKIP_FILE as SERVER_SKIP_FILE } from "../../src/lib/code-repos";

/**
 * A repo added from GitHub in Settings is mapped on the server from file names
 * only. It must leave out and cap the same files as a map built here.
 */

describe("the server's GitHub map matches a local one", () => {
  // protects: the filters can't drift from the CLI's; fails_when: one side changes a skip rule and the other doesn't; no_claim: the rules are right
  it("uses the CLI's skip rules", () => {
    expect(SERVER_SKIP_DIR.source).toBe(SKIP_DIR.source);
    expect(SERVER_SKIP_DIR.flags).toBe(SKIP_DIR.flags);
    expect(SERVER_SKIP_FILE.source).toBe(SKIP_FILE.source);
    expect(SERVER_SKIP_FILE.flags).toBe(SKIP_FILE.flags);
  });

  // protects: capping matches the CLI byte for byte on paths-only maps; fails_when: the two caps keep different files; no_claim: maps with exports (GitHub maps have none)
  it("caps paths exactly like the CLI", () => {
    const long = Array.from({ length: 2500 }, (_, n) => ({ p: `${"x".repeat(n % 7)}/${"y".repeat(40)}/${n}.ts` }));
    expect(capPaths(long.map((f) => f.p))).toEqual(capMap(long));
    const few = [{ p: "a.ts" }, { p: "b/c.ts" }];
    expect(capPaths(few.map((f) => f.p))).toEqual(capMap(few));
  });
});
