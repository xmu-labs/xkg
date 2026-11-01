/**
 * Related captures by visible overlap: shared tags and shared words in the
 * title and summary. No model call, so linking costs nothing and does not
 * grow with the index. The reason names what the two captures share, so a
 * link never claims a deeper connection than the overlap shows.
 */

import { parseIndexRows, type CaptureRow } from "./captures";
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
    "para como pero este esta esto sobre entre cuando donde porque también todo todos tiene puede hacer desde hasta " +
    // Generic in any capture, so sharing them says nothing.
    "show user using used uses thing good better best always never often first keep help work time"
  ).split(" "),
);

/** Singular form, so "retries" and "retry" are one word. Not a stemmer. */
function singular(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) return w.slice(0, -1);
  return w;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map(singular)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}

const basename = (path: string) => path.replace(/^.*\//, "");
const tagKey = (tag: string) => singular(tag.trim().toLowerCase());

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
  // Tags compare in singular form ("agent" matches "agents"); a reason shows
  // the capture's own spelling.
  const ownTags = new Map<string, string>();
  for (const t of capture.tags ?? []) if (t.trim()) ownTags.set(tagKey(t), t.trim().toLowerCase());
  // Ordered and distinct, so a reason lists words in the capture's own order.
  const ownWords = [...new Set(words([capture.slug.replace(/-/g, " "), capture.inferredTitle ?? "", capture.coreIdea ?? ""].join(" ")))];

  // Older rows can hold a bare pipe in the summary; parseIndexRows reads them.
  return parseIndexRows(indexContent)
    .map((row: CaptureRow) => ({ row, path: `${row.status}/${row.filename}` }))
    .filter(({ path }) => path !== selfPath && basename(path) !== filename)
    .map(({ row, path }) => {
      const theirTags = new Set(row.tags.map(tagKey));
      const tagKeys = [...ownTags.keys()].filter((k) => theirTags.has(k));
      const theirWords = new Set(words(`${row.slug.replace(/-/g, " ")} ${row.summary}`));
      // A word that is also a shared tag counts once, as the tag.
      const shared = ownWords.filter((w) => theirWords.has(w) && !tagKeys.includes(w));
      return {
        row,
        path,
        terms: [...tagKeys.map((k) => ownTags.get(k)!), ...shared],
        score: tagKeys.length * TAG_WEIGHT + shared.length,
      };
    })
    .filter((m) => m.score >= MIN_SCORE)
    // Strongest first; on a tie the newer capture, by date then file name.
    .sort((a, b) => b.score - a.score || b.row.date.localeCompare(a.row.date) || b.row.filename.localeCompare(a.row.filename))
    .slice(0, MAX_LINKS)
    .map((m) => ({ filename: m.path, reason: `shared: ${m.terms.slice(0, REASON_TERMS).join(", ")}` }));
}
