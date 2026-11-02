import { describe, it, expect } from "vitest";
import { parseCaptureFile } from "@/lib/capture-detail";

/**
 * Reading a capture back for the capture page: the file as the capture,
 * apply and linking code write it, turned into plain fields the page shows
 * as text. The source text and raw capture at the end are never read.
 */

const FULL = `---
date: 2026-10-30
source: How to write a definition of done for an AI feature
url: https://jeffgothelf.com/blog/how-to-write-a-definition-of-done-for-an-ai-feature/
type: blog
source_type: url
tags: ai-evaluations, product-management, definition-of-done
status: applied
lowConfidence: false
source_id: src-5db1590923fb
---

# How to write a definition of done for an AI feature

## Core idea
A definition of done for an AI feature should combine system-focused evals with explicit customer outcomes.

## Where it applies
**Possible fit** · xmu-labs/xmu-monorepo · from file names, not yet checked in your code · map from 2026-10-30 (7ca84b0)
- \`packages/eval/scenarios/core.json\`
- \`packages/eval/src/config.ts\`: shares names with the capture: \`EvalPlanEntry\` · After: evals name the outcome they move
Also fits: xmu-labs/xkg (Possible fit)

## Key takeaways
- Specify a written eval compliance score required for the feature to ship.
- Name an individual to investigate eval and outcome failures.

## Quotes
> "Eval scores, ultimately, are an output."

> "All of that can pass while the shopper can still easily forget the milk."

## Applied to
Add an expected customer behavior to each eval.

## Evidence
**Core idea** · \`c-3b60b0836e77\`
> "Eval scores, ultimately, are an output." (s7)
>
> "It's number 2, above." (s10)

- Takeaway 1: no checked evidence

**Takeaway 2** · \`c-59112a7d9fb1\`
> "Name a specific individual." (s9)

## Application log
- **Applied:** 2026-10-31
- **Commit:** 3f9a2c1d4e5f
- **Target:** packages/eval/src/config.ts
- **Note:** added outcome line
- **Outcome:** _pending_

- **Applied:** 2026-11-02
- **Outcome:** worked

## Links to memory
- [cost-per-outcome-governance-ai-factory](../inbox/2026-09-08-cost-per-outcome-governance-ai-factory.md) — Both connect AI measurements to outcomes.
- [routing](../applied/2026-09-24-routing.md)

---

<details>
<summary>Raw capture</summary>

## Core idea
not this one

</details>
`;

describe("parseCaptureFile", () => {
  const d = parseCaptureFile(FULL);

  it("reads the frontmatter and title", () => {
    expect(d.title).toBe("How to write a definition of done for an AI feature");
    expect(d.date).toBe("2026-10-30");
    expect(d.type).toBe("blog");
    expect(d.tags).toEqual(["ai-evaluations", "product-management", "definition-of-done"]);
    expect(d.url).toBe("https://jeffgothelf.com/blog/how-to-write-a-definition-of-done-for-an-ai-feature/");
    expect(d.lowConfidence).toBe(false);
  });

  it("reads core idea, takeaways, quotes and advice", () => {
    expect(d.coreIdea).toMatch(/^A definition of done/);
    expect(d.takeaways).toHaveLength(2);
    expect(d.quotes).toEqual([
      "Eval scores, ultimately, are an output.",
      "All of that can pass while the shopper can still easily forget the milk.",
    ]);
    expect(d.advice).toBe("Add an expected customer behavior to each eval.");
  });

  it("reads where it applies, with an optional Impact per file; an old After line is read as a legacy Impact", () => {
    expect(d.where).toEqual({
      fit: "Possible fit",
      repo: "xmu-labs/xmu-monorepo",
      files: [
        { path: "packages/eval/scenarios/core.json" },
        { path: "packages/eval/src/config.ts", why: "shares names with the capture: `EvalPlanEntry`", impact: "evals name the outcome they move", legacy: true },
      ],
      also: [{ repo: "xmu-labs/xkg", fit: "Possible fit" }],
      note: "From file names, not yet checked in your code · map from 2026-10-30 (7ca84b0)",
    });
  });

  it("reads an Impact line as current, not legacy", () => {
    const file = FULL.replace("· After: evals name the outcome they move", "· Impact: each eval names the customer outcome it moves");
    expect(parseCaptureFile(file).where!.files[1]).toEqual({
      path: "packages/eval/src/config.ts",
      why: "shares names with the capture: `EvalPlanEntry`",
      impact: "each eval names the customer outcome it moves",
    });
  });

  it("reads the evidence by claim", () => {
    expect(d.evidence).toEqual([
      { label: "Core idea", quotes: ["Eval scores, ultimately, are an output. (s7)", "It's number 2, above. (s10)"] },
      { label: "Takeaway 2", quotes: ["Name a specific individual. (s9)"] },
    ]);
  });

  it("reads each apply in the log", () => {
    expect(d.applications).toEqual([
      { date: "2026-10-31", commit: "3f9a2c1d4e5f", target: "packages/eval/src/config.ts", note: "added outcome line", outcome: null },
      { date: "2026-11-02", commit: null, target: null, note: null, outcome: "worked" },
    ]);
  });

  it("reads links to memory as capture names", () => {
    expect(d.links).toEqual([
      { name: "2026-09-08-cost-per-outcome-governance-ai-factory.md", slug: "cost-per-outcome-governance-ai-factory", note: "Both connect AI measurements to outcomes." },
      { name: "2026-09-24-routing.md", slug: "routing", note: null },
    ]);
  });

  it("never reads headings inside the raw capture or source text", () => {
    expect(d.coreIdea).not.toBe("not this one");
  });
});

describe("parseCaptureFile on older and odd files", () => {
  it("leaves out what an old capture doesn't have", () => {
    const d = parseCaptureFile(`---\ndate: 2026-03-14\nsource: Skills\nurl: none\ntype: notes\ntags: founder, work\nstatus: inbox\n---\n\n# Skills for AI agents\n\n## Core idea\nAgents need skills.\n\n## Key takeaways\n- One\n\n## Quotes\n_none_\n\n## Applied to\n_not immediately obvious_\n\n## Links to memory\n_none yet_\n`);
    expect(d.url).toBeNull();
    expect(d.quotes).toEqual([]);
    expect(d.advice).toBeNull();
    expect(d.where).toBeNull();
    expect(d.evidence).toEqual([]);
    expect(d.applications).toEqual([]);
    expect(d.links).toEqual([]);
    expect(d.lowConfidence).toBe(false);
  });

  it("reads the oldest captures' modes as their tags", () => {
    // Regression: ISSUE-001 — tags missing on captures saved with `modes:`
    // Found by /qa on 2026-10-31
    expect(parseCaptureFile(`---\ndate: 2026-03-14\nmodes: founder, work\nstatus: inbox\n---\n\n# Skills\n`).tags).toEqual(["founder", "work"]);
  });

  it("keeps a no-fit line as the note, with no repo", () => {
    const d = parseCaptureFile(`---\ndate: 2026-10-30\n---\n\n# T\n\n## Core idea\nX\n\n## Where it applies\nNo clear fit in your repos yet: the closest files are only a weak match.\n\n## Key takeaways\n- Y\n`);
    expect(d.where).toEqual({ fit: "No clear fit", repo: null, files: [], also: [], note: "No clear fit in your repos yet: the closest files are only a weak match." });
  });

  it("flags low confidence and keeps markup as plain text", () => {
    const d = parseCaptureFile(`---\nlowConfidence: true\nurl: javascript:alert(1)\n---\n\n# <img src=x onerror=alert(1)>\n\n## Core idea\nNo core idea could be extracted from the input.\n\n## Key takeaways\n- <script>alert(1)</script>\n`);
    expect(d.lowConfidence).toBe(true);
    expect(d.url).toBeNull();
    expect(d.title).toBe("<img src=x onerror=alert(1)>");
    expect(d.takeaways).toEqual(["<script>alert(1)</script>"]);
  });

  it("never reads headings inside the source text of an MCP capture, which has no --- before it", () => {
    const mcp = `---\ndate: 2026-10-30\nstatus: inbox\n---\n\n# T\n\n## Core idea\nX\n\n## Links to memory\n_none yet_\n\n<details>\n<summary>Source text (sha256: abc)</summary>\n\n[s1] Example input:\n## Application log\n- **Applied:** 2020-01-01\n## Where it applies\n**Strong fit** · evil/repo\n\n</details>\n`;
    const d = parseCaptureFile(mcp);
    expect(d.applications).toEqual([]);
    expect(d.where).toBeNull();
    expect(d.coreIdea).toBe("X");
  });

  it("drops links that could leave the knowledge repo", () => {
    const d = parseCaptureFile(`---\n---\n\n# T\n\n## Core idea\nX\n\n## Links to memory\n- [a](../../etc/passwd.md) — no\n- [b](https://evil.example/x.md) — no\n- [c](../inbox/2026-01-01-c.md) — yes\n`);
    expect(d.links.map((l) => l.name)).toEqual(["2026-01-01-c.md"]);
  });
});
