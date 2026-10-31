/**
 * Related captures by visible overlap: shared tags and shared words in the
 * title and summary. No model call, so linking costs nothing and does not
 * grow with the index. The reason names what the two captures share, so a
 * link never claims a deeper connection than the overlap shows.
 */

import type { ExtractedCapture, RelatedCapture } from "./types";

/** Links written per capture; also bounds the back-link writes. */
export const MAX_LINKS = 3;
/** A shared tag counts this much; a shared word counts 1. */
const TAG_WEIGHT = 2;
/** Below this a match is too weak: one shared tag alone, or two shared words. */
const MIN_SCORE = 3;
/** Shared terms named in a reason. */
const REASON_TERMS = 4;

const STOPWORDS = new Set(
  (
    "about above after again also among another because been before being below between both cannot could does doing down during each even every from further have having here into just like made make makes many more most much must need needs only other over same should since some such than that their them then there these they this those through under until upon very want were what when where which while will with within without would your yours " +
    "para como pero este esta esto sobre entre cuando donde porque también todo todos tiene puede hacer desde hasta"
  ).split(" "),
);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}

const basename = (path: string) => path.replace(/^.*\//, "");

interface IndexRow {
  path: string;
  slug: string;
  summary: string;
  tags: string[];
}

/** INDEX.md table rows that link to a capture file. Escaped pipes stay inside their cell. */
function parseRows(indexContent: string): IndexRow[] {
  const rows: IndexRow[] = [];
  for (const line of indexContent.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split(/(?<!\\)\|/).map((c) => c.trim());
    const link = cells[2]?.match(/^\[([^\]]*)\]\(([^)]+\.md)\)$/);
    if (!link) continue;
    rows.push({
      slug: link[1]!,
      path: link[2]!.replace(/^\.?\//, ""),
      summary: (cells[3] ?? "").replace(/\.\.\.$/, "").replace(/\\\|/g, " "),
      tags: (cells[4] ?? "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean),
    });
  }
  return rows;
}

/**
 * Up to MAX_LINKS captures from the index that share enough with `capture`,
 * strongest overlap first and newer first on a tie. The capture's own row is
 * never a candidate, matched by repo path or by bare filename.
 */
export function relatedByOverlap(
  capture: ExtractedCapture,
  indexContent: string,
  selfPath: string,
  filename: string,
): RelatedCapture[] {
  const ownTags = new Set((capture.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean));
  // Ordered and distinct, so a reason lists words in the capture's own order.
  const ownWords = [...new Set(words([capture.slug.replace(/-/g, " "), capture.inferredTitle ?? "", capture.coreIdea ?? ""].join(" ")))];

  return parseRows(indexContent)
    .map((row, i) => ({ row, i }))
    .filter(({ row }) => row.path !== selfPath && basename(row.path) !== filename)
    .map(({ row, i }) => {
      const tags = [...ownTags].filter((t) => row.tags.includes(t));
      const theirs = new Set(words(`${row.slug.replace(/-/g, " ")} ${row.summary}`));
      const shared = ownWords.filter((w) => theirs.has(w) && !tags.includes(w));
      return { row, i, terms: [...tags, ...shared], score: tags.length * TAG_WEIGHT + shared.length };
    })
    .filter((m) => m.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score || b.i - a.i)
    .slice(0, MAX_LINKS)
    .map((m) => ({ filename: m.row.path, reason: `shared: ${m.terms.slice(0, REASON_TERMS).join(", ")}` }));
}
