import { describe, it, expect } from "vitest";
import { insertWhereSection, readWhereSection, whereSection, type WhereResult } from "../where";
import { buildMarkdown } from "../llm";
import type { ExtractedCapture } from "../types";

/**
 * The card's "Hand off" button names a capture and a repo; the server takes
 * the files and fit from the capture's own "Where it applies" section, so a
 * client can't queue paths xkg never suggested.
 */

const capture: ExtractedCapture = {
  slug: "llm-memory", inferredTitle: "LLM Memory", inferredAuthor: null, inferredUrl: null, inferredType: "article",
  coreIdea: "Memory goes into the prompt.", takeaways: ["Long prompts lose detail."], quotes: [], tags: ["llm"],
  appliedTo: null, lowConfidence: false,
};

const where: WhereResult = {
  repo: "acme/app", tier: "strong",
  files: [{ path: "src/llm.ts", why: "`rank` sends the whole index" }, { path: "src/brief ing.ts" }],
  also: [{ repo: "acme/web", tier: "possible" }, { repo: "acme/cli", tier: "strong" }],
  map: { date: "2026-10-29", head7: "abc1234" }, scorer: "evidence", modelConf: null,
};

const saved = (w: WhereResult, source = "raw") => insertWhereSection(buildMarkdown("2026-10-29", capture, source), whereSection(w)!);

describe("readWhereSection", () => {
  // protects: the button queues what the card showed; fails_when: the repo, tier, a file or an also-fits repo is lost on the way back; no_claim: the section's wording
  it("reads back the repo, tier, files and also-fits repos the section was written with", () => {
    expect(readWhereSection(saved(where))).toEqual({
      repo: "acme/app", tier: "strong", files: ["src/llm.ts", "src/brief ing.ts"],
      also: [{ repo: "acme/web", tier: "possible" }, { repo: "acme/cli", tier: "strong" }],
    });
  });

  // protects: a file name with backticks is queued as the file the card showed; fails_when: a path is cut at its first backtick, or loses a leading or trailing backtick or space; no_claim: none
  it("reads back paths with backticks whole", () => {
    const paths = ["src/a`b.ts", "src/a``b`.ts", "`lead.ts", "trail.ts`", " space.ts", "plain.ts"];
    const odd: WhereResult = { ...where, files: paths.map((path) => ({ path, why: "uses `x`" })) };
    expect(readWhereSection(saved(odd))?.files).toEqual(paths);
    expect(whereSection(where)).toContain("- `src/llm.ts`: `rank` sends the whole index\n");
  });

  // protects: a no-fit section offers nothing to queue; fails_when: a no-fit line reads as a repo; no_claim: none
  it("reads a no-fit section as no repo", () => {
    const none: WhereResult = { repo: null, tier: "none", files: [], also: [], noFit: { reason: "weak" }, scorer: "evidence", modelConf: null };
    expect(readWhereSection(saved(none))).toBeNull();
  });

  // protects: only xkg's own section counts; fails_when: a section inside the captured source is read; no_claim: none
  it("ignores a section that only the captured source has", () => {
    const md = buildMarkdown("2026-10-29", capture, "## Where it applies\n**Strong fit** · evil/repo · x\n- `etc/passwd`\n");
    expect(readWhereSection(md)).toBeNull();
  });
});
