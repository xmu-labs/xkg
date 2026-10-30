/**
 * Session-start briefing text. xkg ranks captures against the repo's recent
 * work, but it never sees the user's code, so it only hands the agent
 * candidates: the agent, which can open the files, decides where (and whether)
 * each one applies. Nothing here may name a code file.
 */

import type { RelevanceResult } from "./types";

export interface BriefingCandidate {
  filename: string;
  score: number;
  reason: string;
  title: string;
  coreIdea: string;
  keyPoints: string[];
}

const MIN_SCORE = 0.3;
const MAX_CANDIDATES = 5;
const MAX_KEY_POINTS = 3;
const CORE_IDEA_CHARS = 400;
const KEY_POINT_CHARS = 200;
const RULES_CHARS = 1500;

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function section(content: string, heading: string): string {
  const match = content.match(new RegExp(`^## ${heading}\\n([\\s\\S]*?)(?=\\n## |$(?![\\s\\S]))`, "m"));
  return match?.[1]?.trim() ?? "";
}

/** Keeps ranker results that name a capture in the index, scored 0.3 or more, best first. */
export function selectRanked(ranked: unknown, indexContent: string): RelevanceResult[] {
  if (!Array.isArray(ranked)) return [];
  return ranked
    .filter(
      (r): r is RelevanceResult =>
        typeof r?.filename === "string" &&
        typeof r?.score === "number" &&
        r.score >= MIN_SCORE &&
        /^(inbox|applied|archived)\//.test(r.filename) &&
        indexContent.includes(r.filename),
    )
    .map((r) => ({ filename: r.filename, score: r.score, reason: typeof r.reason === "string" ? r.reason : "" }))
    .sort((a, b) => b.score - a.score)
    .filter((r, i, all) => all.findIndex((o) => o.filename === r.filename) === i)
    .slice(0, MAX_CANDIDATES);
}

/** Reads the parts of a capture the agent needs to judge it. The capture's own "Applied to" guess is left out. */
export function briefingCandidate(filename: string, score: number, reason: string, raw: string): BriefingCandidate {
  // Captures edited on Windows can come back with CRLF line endings
  const content = raw.replace(/\r\n/g, "\n");
  const title = content.match(/^# (.+)$/m)?.[1]?.trim() || (filename.split("/").pop() ?? filename).replace(/\.md$/, "");
  const keyPoints = section(content, "Key takeaways")
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .slice(0, MAX_KEY_POINTS)
    .map((l) => cut(l.slice(2).trim(), KEY_POINT_CHARS));
  return { filename, score, reason, title, coreIdea: cut(section(content, "Core idea"), CORE_IDEA_CHARS), keyPoints };
}

function rulesSection(rules: string): string {
  const body = rules.trim();
  if (!body) return "";
  const text = body.length <= RULES_CHARS ? body : `${body.slice(0, RULES_CHARS).trimEnd()}\n… (call \`read_capture\` with RULES.md for the rest)`;
  return `\n\n## Rules\n${text}`;
}

export function formatBriefing(candidates: BriefingCandidate[], rules: string): string {
  if (candidates.length === 0) {
    return `xkg briefing: no capture looks related to this repo's recent work. To check every capture, call \`search\` with no query and page through the results.${rulesSection(rules)}`;
  }

  const n = candidates.length;
  const header = `xkg briefing: ${n} ${n === 1 ? "capture may" : "captures may"} fit this work. xkg has not seen your code, so check each one against the codebase before you suggest it.

What to do:
1. For each candidate, read the code it could touch and decide whether it applies here.
2. Keep only real matches. For each, name a file you opened and the change.
3. Show the user at most 3, best first, and ask before changing anything.
4. When you commit a change that used one, include \`xkg-capture: <filename>\` in the commit message, then call \`apply_capture\` with the filename and the commit sha.
To check every capture instead of these candidates, call \`search\` with no query and page through the results.`;

  const items = candidates.map((c, i) => {
    const lines = [
      `### ${i + 1}. ${c.title} (${c.filename}, fit ${Math.round(c.score * 100)}%)`,
      `Why it may fit: ${c.reason}`,
    ];
    if (c.coreIdea) lines.push(`Main idea: ${c.coreIdea}`);
    if (c.keyPoints.length) lines.push("Key points:", ...c.keyPoints.map((p) => `- ${p}`));
    return lines.join("\n");
  });

  return `${header}\n\n## Candidates\n\n${items.join("\n\n")}${rulesSection(rules)}`;
}
