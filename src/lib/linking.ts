/**
 * Auto-linking: connects new captures to related existing captures.
 * Populates "Links to memory" sections and maintains back-links.
 */

import { readFile, githubPut } from "./github";
import { findRelatedCaptures, type LlmConfig } from "./llm";
import type { ExtractedCapture, RelatedCapture } from "./types";

/** Format related captures as Markdown links for the "Links to memory" section. */
function formatLinks(related: RelatedCapture[]): string {
  if (related.length === 0) return "_none yet_";
  return related
    .map((r) => {
      const slug = r.filename.replace(/^.*\//, "").replace(/\.md$/, "").replace(/^\d{4}-\d{2}-\d{2}-/, "");
      return `- [${slug}](../${r.filename}) — ${r.reason}`;
    })
    .join("\n");
}

/** Build a back-link line from a new capture to insert into an existing capture. */
function buildBackLink(newFilename: string, newSlug: string, reason: string): string {
  return `- [${newSlug}](../${newFilename}) — ${reason}`;
}

/**
 * Auto-link a newly created capture to related existing captures.
 * Updates the new capture's "Links to memory" section and adds back-links
 * to related captures (up to 3 to limit GitHub API calls).
 */
export async function linkCapture(
  apiKey: string,
  githubToken: string,
  repo: string,
  capture: ExtractedCapture,
  filename: string,
  folder: string,
  indexContent: string,
  llm: LlmConfig = "anthropic",
): Promise<RelatedCapture[]> {
  // Find related captures via LLM
  const related = await findRelatedCaptures(apiKey, capture, indexContent, llm);
  if (related.length === 0) return [];

  // Update the new capture's "Links to memory" section
  const newFilePath = `${folder}/${filename}`;
  const newFile = await readFile(githubToken, repo, newFilePath);
  if (newFile) {
    const updatedContent = newFile.content.replace(
      /## Links to memory\n_none yet_/,
      `## Links to memory\n${formatLinks(related)}`,
    );
    if (updatedContent !== newFile.content) {
      await githubPut(githubToken, repo, newFilePath, updatedContent, `link: add connections to ${filename}`, newFile.sha);
    }
  }

  // Add back-links to related captures (limit to 3 to avoid excessive API calls)
  const newSlug = capture.slug;
  const backLinkPromises = related.slice(0, 3).map(async (r) => {
    try {
      const relatedFile = await readFile(githubToken, repo, r.filename);
      if (!relatedFile) return;

      const backLink = buildBackLink(newFilePath, newSlug, r.reason);

      let updatedContent: string;
      if (relatedFile.content.includes("## Links to memory\n_none yet_")) {
        updatedContent = relatedFile.content.replace(
          "## Links to memory\n_none yet_",
          `## Links to memory\n${backLink}`,
        );
      } else if (relatedFile.content.includes("## Links to memory\n")) {
        updatedContent = relatedFile.content.replace(
          "## Links to memory\n",
          `## Links to memory\n${backLink}\n`,
        );
      } else {
        // No "Links to memory" section — append one
        updatedContent = relatedFile.content.trimEnd() + `\n\n## Links to memory\n${backLink}\n`;
      }

      if (updatedContent !== relatedFile.content) {
        const relatedFilename = r.filename.replace(/^.*\//, "");
        await githubPut(githubToken, repo, r.filename, updatedContent, `link: back-link from ${filename} to ${relatedFilename}`, relatedFile.sha);
      }
    } catch {
      // Back-linking is best-effort — don't fail the capture
    }
  });

  await Promise.all(backLinkPromises);

  return related;
}
