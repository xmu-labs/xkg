import { describe, it, expect } from "vitest";
import { splitCode } from "../code-names";

/**
 * Why and Impact lines name files and functions. The capture page shows those
 * names as code chips, so the user sees they are files in their code and not
 * prose. Names come in backticks, or bare when the model left them out.
 */

const code = (text: string) => splitCode(text).filter((p) => p.code).map((p) => p.text);

describe("splitCode", () => {
  it("keeps plain text as one plain part", () => {
    expect(splitCode("Routes simple tasks to smaller models.")).toEqual([{ code: false, text: "Routes simple tasks to smaller models." }]);
  });

  it("marks backticked names as code", () => {
    expect(splitCode("Change `callLlm` here.")).toEqual([
      { code: false, text: "Change " },
      { code: true, text: "callLlm" },
      { code: false, text: " here." },
    ]);
  });

  // fails_when: a bare file name in Why or Impact reads as prose
  it("marks bare file names and paths as code, without the sentence's punctuation", () => {
    expect(code("Implements suggest.ts and warns, like packages/llm/src/policy.ts.")).toEqual(["suggest.ts", "packages/llm/src/policy.ts"]);
    expect(code("See src/lib/llm.ts, cli/agent.ts; and README.md")).toEqual(["src/lib/llm.ts", "cli/agent.ts", "README.md"]);
    expect(code("Update crates/xmu-core/src/policy.rs (the router).")).toEqual(["crates/xmu-core/src/policy.rs"]);
  });

  it("leaves words with dots that aren't file names alone", () => {
    expect(code("Costs drop, e.g. by 10x. Version 1.2 ships. Visit example.com or Node.js today.")).toEqual([]);
  });

  it("doesn't mark names twice inside backticks", () => {
    expect(splitCode("Edit `src/lib/llm.ts` now")).toEqual([
      { code: false, text: "Edit " },
      { code: true, text: "src/lib/llm.ts" },
      { code: false, text: " now" },
    ]);
  });

  it("keeps the text exactly when joined back", () => {
    const t = "Edit `x` in src/a.ts, then b.py. Done";
    expect(splitCode(t).map((p) => (p.code && t.includes(`\`${p.text}\``) ? `\`${p.text}\`` : p.text)).join("")).toBe(t);
  });
});
