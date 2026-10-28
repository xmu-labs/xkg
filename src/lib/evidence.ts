/**
 * Source-grounded evidence for extraction.
 *
 * The extraction prompt asks the model to cite app-supplied ids: a source, a
 * version of that source, and numbered segments of its text. This module
 * builds those ids, sends them in the shape the prompt expects, checks every
 * quote the model cites against the segment it names, and renders the checked
 * claims and the exact source text into the capture file so they can be
 * re-checked later.
 */

import { createHash } from "node:crypto";
import type { Claim, ClaimEvidence, ExtractedCapture, SourceSegment, SourceSnapshot } from "./types";

/** Longest segment sent to the model. Fetched pages arrive as one long line. */
const MAX_SEGMENT_CHARS = 600;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Split long text at sentence ends, then hard-split anything still too long. */
function splitBlock(block: string): string[] {
  if (block.length <= MAX_SEGMENT_CHARS) return [block];

  const pieces = block.split(/(?<=[.!?]["')\]]*\s)/);
  const packed: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current && (current + piece).trim().length > MAX_SEGMENT_CHARS) {
      packed.push(current.trim());
      current = "";
    }
    current += piece;
  }
  if (current.trim()) packed.push(current.trim());

  return packed.flatMap((p) => {
    const out: string[] = [];
    for (let i = 0; i < p.length; i += MAX_SEGMENT_CHARS) out.push(p.slice(i, i + MAX_SEGMENT_CHARS));
    return out;
  });
}

/** Paragraphs of the text, with long paragraphs split to segment size. */
export function segmentText(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b !== "")
    .flatMap(splitBlock);
}

/** The text a snapshot's hash covers: its segments joined by a blank line. */
export function sourceText(source: SourceSnapshot): string {
  return source.segments.map((s) => s.text).join("\n\n");
}

/** Build the source the extraction runs on and the claims are checked against. */
export function buildSource(
  content: string,
  opts: { title?: string; url?: string; maxChars?: number } = {},
): SourceSnapshot {
  const max = opts.maxChars ?? Infinity;
  const truncated = content.length > max;
  const segments: SourceSegment[] = segmentText(truncated ? content.slice(0, max) : content)
    .map((text, i) => ({ segmentId: `s${i + 1}`, text }));
  const hash = sha256(segments.map((s) => s.text).join("\n\n"));

  return {
    sourceId: `src-${(opts.url ? sha256(opts.url) : hash).slice(0, 12)}`,
    sourceVersionId: `v-${hash.slice(0, 12)}`,
    sha256: hash,
    ...(opts.title ? { title: opts.title } : {}),
    ...(opts.url ? { url: opts.url } : {}),
    truncated,
    segments,
  };
}

/** The user message for extraction: ids, metadata and segments, as JSON. */
export function buildExtractionInput(source: SourceSnapshot): string {
  return JSON.stringify({
    sourceId: source.sourceId,
    sourceVersionId: source.sourceVersionId,
    metadata: {
      ...(source.title ? { title: source.title } : {}),
      ...(source.url ? { url: source.url } : {}),
      ...(source.truncated ? { truncated: true } : {}),
    },
    segments: source.segments,
  });
}

/** A claim id that stays the same for the same text from the same source version. */
export function claimId(sourceVersionId: string, text: string): string {
  return `c-${sha256(`${sourceVersionId}\n${text}`).slice(0, 12)}`;
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** The output field a claim path points at, or null if there is none. */
function fieldText(path: string, fields: { coreIdea: string | null; takeaways: string[] }): string | null {
  if (path === "/coreIdea") return fields.coreIdea;
  const m = /^\/takeaways\/(\d+)$/.exec(path);
  return m ? (fields.takeaways[Number(m[1])] ?? null) : null;
}

/**
 * Keep only claims the source backs. Evidence survives when it names the ids
 * this source was sent with and its quote occurs in the named segment
 * (whitespace aside). A claim survives when it points at a real coreIdea or
 * takeaway and keeps at least one piece of evidence. The model is never
 * trusted for ids or claim text: the text is taken from the field itself.
 */
export function checkClaims(
  raw: unknown,
  fields: { coreIdea: string | null; takeaways: string[] },
  source: SourceSnapshot,
): Claim[] {
  if (!Array.isArray(raw)) return [];
  const segments = new Map(source.segments.map((s) => [s.segmentId, squash(s.text)]));
  const seen = new Set<string>();
  const claims: Claim[] = [];

  for (const item of raw) {
    const r = asRecord(item);
    if (!r || typeof r.outputPath !== "string" || seen.has(r.outputPath)) continue;
    const text = fieldText(r.outputPath, fields);
    if (text === null || !Array.isArray(r.evidence)) continue;

    const evidence: ClaimEvidence[] = [];
    for (const e of r.evidence) {
      const ev = asRecord(e);
      if (!ev || ev.sourceId !== source.sourceId || ev.sourceVersionId !== source.sourceVersionId) continue;
      if (typeof ev.segmentId !== "string" || typeof ev.exactQuote !== "string") continue;
      const segment = segments.get(ev.segmentId);
      const quote = squash(ev.exactQuote);
      if (segment === undefined || quote === "" || !segment.includes(quote)) continue;
      evidence.push({
        sourceId: source.sourceId,
        sourceVersionId: source.sourceVersionId,
        segmentId: ev.segmentId,
        exactQuote: ev.exactQuote,
      });
    }
    if (evidence.length === 0) continue;

    seen.add(r.outputPath);
    claims.push({ id: claimId(source.sourceVersionId, text), outputPath: r.outputPath, text, kind: "source_assertion", evidence });
  }
  return claims;
}

/** Frontmatter lines that tie a capture to the exact source it came from. */
export function sourceFrontmatter(capture: ExtractedCapture): string[] {
  const s = capture.source;
  return s ? [`source_id: ${s.sourceId}`, `source_version: ${s.sourceVersionId}`, `source_sha256: ${s.sha256}`] : [];
}

/** The Evidence section: each coreIdea/takeaway with its checked quotes. */
export function renderEvidenceSection(capture: ExtractedCapture): string {
  if (!capture.source) return "";
  const byPath = new Map((capture.claims ?? []).map((c) => [c.outputPath, c]));
  const rows: Array<[string, string]> = [
    ["/coreIdea", "Core idea"],
    ...capture.takeaways.map((_, i): [string, string] => [`/takeaways/${i}`, `Takeaway ${i + 1}`]),
  ];

  const blocks = rows.map(([path, label]) => {
    const claim = byPath.get(path);
    if (!claim) return `- ${label}: no checked evidence`;
    const quotes = claim.evidence.map((e) => `> "${squash(e.exactQuote)}" (${e.segmentId})`).join("\n>\n");
    return `**${label}** · \`${claim.id}\`\n${quotes}`;
  });

  return `## Evidence\n${blocks.join("\n\n")}\n`;
}

/** The exact source text the evidence was checked against, with its hash. */
export function renderSourceSection(capture: ExtractedCapture): string {
  const s = capture.source;
  if (!s) return "";
  const note = s.truncated ? "\n_Source was cut to fit the extraction limit._\n" : "";
  const body = s.segments.map((seg) => `[${seg.segmentId}] ${seg.text}`).join("\n\n");
  return `<details>
<summary>Source text (sha256: ${s.sha256})</summary>
${note}
${body}

</details>
`;
}
