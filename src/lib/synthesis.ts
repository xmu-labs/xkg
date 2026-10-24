/**
 * Knowledge synthesis: distills captures into rules and manages RULES.md.
 */

import { readFile, githubPut } from "./github";
import { synthesizeRules, type LlmConfig } from "./llm";
import type { SynthesisResult } from "./types";

/** Update (or create) a topic section in RULES.md. */
export async function updateRulesFile(
  githubToken: string,
  repo: string,
  result: SynthesisResult,
): Promise<void> {
  const existing = await readFile(githubToken, repo, "RULES.md");

  const sectionHeader = `## ${result.topic}`;
  const sectionContent = result.rules.map((r) => `- ${r}`).join("\n");
  const newSection = `${sectionHeader}\n${sectionContent}`;

  const today = new Date().toISOString().split("T")[0];

  if (existing) {
    let content = existing.content;

    // Update the "Last updated" date
    content = content.replace(
      /> Auto-generated.*Last updated: \d{4}-\d{2}-\d{2}\./,
      `> Auto-generated from captured insights. Last updated: ${today}.`,
    );

    // Replace existing section or append new one
    const sectionRegex = new RegExp(
      `## ${escapeRegex(result.topic)}\n(?:- [^\n]+\n?)*`,
      "m",
    );

    if (sectionRegex.test(content)) {
      content = content.replace(sectionRegex, newSection + "\n");
    } else {
      content = content.trimEnd() + `\n\n${newSection}\n`;
    }

    await githubPut(githubToken, repo, "RULES.md", content, `synthesize: update rules for ${result.topic}`, existing.sha);
  } else {
    // Create RULES.md from scratch
    const content = `# Knowledge Rules

> Auto-generated from captured insights. Last updated: ${today}.

${newSection}
`;
    await githubPut(githubToken, repo, "RULES.md", content, `synthesize: create rules with ${result.topic}`);
  }
}

/**
 * Synthesize rules for a topic by reading all matching captures and calling the LLM.
 * Returns the synthesis result and updates RULES.md.
 */
export async function synthesizeTopic(
  apiKey: string,
  githubToken: string,
  repo: string,
  tag: string,
  indexContent: string,
  llm: LlmConfig = "anthropic",
): Promise<SynthesisResult> {
  // Find captures matching this tag from the index
  const lines = indexContent
    .split("\n")
    .filter((l) => l.startsWith("|") && !l.startsWith("| Date") && !l.startsWith("|---"));

  const matchingLines = lines.filter((l) => l.toLowerCase().includes(tag.toLowerCase()));

  // Extract filenames from matching index rows
  const filenameRegex = /\[([^\]]+)\]\(([^)]+)\)/;
  const filenames: string[] = [];
  for (const line of matchingLines) {
    const match = line.match(filenameRegex);
    if (match?.[2]) filenames.push(match[2]);
  }

  if (filenames.length === 0) {
    return { topic: tag, rules: [] };
  }

  // Read capture contents in parallel (cap at 20)
  const toRead = filenames.slice(0, 20);
  const contents = await Promise.all(
    toRead.map(async (f) => {
      const file = await readFile(githubToken, repo, f);
      return file?.content ?? null;
    }),
  );

  const validContents = contents.filter((c): c is string => c !== null);
  if (validContents.length === 0) {
    return { topic: tag, rules: [] };
  }

  // Synthesize via LLM
  const result = await synthesizeRules(apiKey, tag, validContents, llm);

  // Update RULES.md
  await updateRulesFile(githubToken, repo, result);

  return result;
}

/** Escape special regex characters in a string. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
