/**
 * One capture read back for the capture page: the file as the capture, apply
 * and linking code write it, turned into plain fields. The page shows them as
 * text, never as HTML. Only the capture's own sections are read; the raw
 * capture and source text after the closing `---` can hold any heading.
 */

import { captureName, type CaptureStatus } from "@/lib/captures";
import { readCodeSpan } from "@/lib/where";

export type CaptureWhere = {
  fit: string;
  repo: string | null;
  /** `legacy`: the line is an old "· After:" edit description, shown as Impact until it is rewritten. */
  files: Array<{ path: string; why?: string; impact?: string; legacy?: boolean }>;
  also: Array<{ repo: string; fit: string }>;
  note: string;
};

export type CaptureApplication = {
  date: string;
  commit: string | null;
  target: string | null;
  note: string | null;
  /** Null while the outcome is still pending. */
  outcome: string | null;
};

/** `summary` is the linked capture's INDEX.md summary, added by the read route. */
export type CaptureLink = { name: string; slug: string; note: string | null; summary?: string | null };

export type CaptureFileFields = {
  title: string;
  date: string;
  type: string | null;
  tags: string[];
  /** The source, only when it is an http(s) URL. */
  url: string | null;
  lowConfidence: boolean;
  coreIdea: string | null;
  takeaways: string[];
  quotes: string[];
  /** "Applied to": how to use it. */
  advice: string | null;
  where: CaptureWhere | null;
  evidence: Array<{ label: string; quotes: string[] }>;
  applications: CaptureApplication[];
  links: CaptureLink[];
};

export type CaptureDetail = CaptureFileFields & {
  filename: string;
  status: CaptureStatus;
  /** The file on GitHub. */
  fileUrl: string;
};

/** Values the writers use for "nothing here". */
const EMPTY = new Set(["_none_", "_none yet_", "_not immediately obvious_", "_pending_", "none", ""]);
const value = (s: string | undefined): string | null => {
  const t = s?.trim() ?? "";
  return EMPTY.has(t) ? null : t;
};

function frontmatter(content: string): { fields: Map<string, string>; body: string } {
  const m = /^---\n(?:([\s\S]*?)\n)?---(?:\n|$)/.exec(content);
  const fields = new Map<string, string>();
  for (const line of m?.[1]?.split("\n") ?? []) {
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (kv && !fields.has(kv[1]!)) fields.set(kv[1]!, kv[2]!.trim());
  }
  return { fields, body: m ? content.slice(m[0].length) : content };
}

/**
 * The capture's own part: everything before the raw capture and source text.
 * Web captures put a `---` line before them; MCP captures go straight to the
 * source text's `<details>` block.
 */
function ownPart(body: string): string {
  const ends = [body.search(/\n---\n/), body.search(/^<details>/m)].filter((i) => i >= 0);
  return ends.length ? body.slice(0, Math.min(...ends)) : body;
}

/** "## Heading" → its text, first occurrence only. */
function sections(own: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = own.split(/^## /m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf("\n");
    const heading = (nl < 0 ? part : part.slice(0, nl)).trim();
    if (!out.has(heading)) out.set(heading, nl < 0 ? "" : part.slice(nl + 1).trim());
  }
  return out;
}

/** "- item" lines; an indented line continues the item above. */
function bullets(text: string | undefined): string[] {
  const items: string[] = [];
  for (const line of (text ?? "").split("\n")) {
    if (line.startsWith("- ")) items.push(line.slice(2).trim());
    else if (/^\s+\S/.test(line) && items.length) items[items.length - 1] += ` ${line.trim()}`;
  }
  return items.filter(Boolean);
}

/** Quote blocks, one per run of `>` lines; a `>` alone splits quotes inside a block. */
function quoteBlocks(text: string | undefined): string[] {
  const quotes: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const q = current.join(" ").trim();
    if (q) quotes.push(q);
    current = [];
  };
  for (const line of (text ?? "").split("\n")) {
    if (!line.startsWith(">")) { flush(); continue; }
    const t = line.replace(/^>\s?/, "");
    if (!t.trim()) flush();
    else current.push(t.trim());
  }
  flush();
  return quotes.map(unquote);
}

/** Drops the quote marks the writer adds, keeping a trailing segment id like "(s7)". */
function unquote(q: string): string {
  const m = /^["“]([\s\S]*)["”](\s+\(s\d+\))?$/.exec(q);
  return m ? `${m[1]}${m[2] ?? ""}` : q;
}

function whereOf(text: string | undefined): CaptureWhere | null {
  const lines = (text ?? "").split("\n").map((l) => l.trimEnd()).filter(Boolean);
  if (!lines.length) return null;
  const head = /^\*\*(.+?)\*\* · (\S+)(?: · (.*))?$/.exec(lines[0]!);
  if (!head) return { fit: "No clear fit", repo: null, files: [], also: [], note: lines.join(" ") };
  const files: CaptureWhere["files"] = [];
  for (const line of lines.slice(1)) {
    if (!line.startsWith("- `")) continue;
    const path = readCodeSpan(line.slice(2));
    if (!path) continue;
    const span = /^(`+)(?!`).*?[^`]\1(?!`)/.exec(line.slice(2))![0];
    const rest = line.slice(2 + span.length).replace(/^:\s*/, "");
    const [why, impact, marker] = (() => {
      const m = /\s·\s(Impact|After):\s*/.exec(rest);
      return m ? [rest.slice(0, m.index), rest.slice(m.index + m[0].length), m[1]] : [rest, undefined, undefined];
    })();
    files.push({
      path,
      ...(why?.trim() ? { why: why.trim() } : {}),
      ...(impact?.trim() ? { impact: impact.trim(), ...(marker === "After" ? { legacy: true as const } : {}) } : {}),
    });
  }
  const alsoLine = lines.find((l) => l.startsWith("Also fits: "))?.slice("Also fits: ".length) ?? "";
  const also = alsoLine.split(", ").flatMap((part) => {
    const m = /^(\S+) \((.+)\)$/.exec(part);
    return m ? [{ repo: m[1]!, fit: m[2]! }] : [];
  });
  const rest = head[3] ?? "";
  return { fit: head[1]!, repo: head[2]!, files, also, note: rest.charAt(0).toUpperCase() + rest.slice(1) };
}

function evidenceOf(text: string | undefined): CaptureFileFields["evidence"] {
  return (text ?? "").split(/\n\s*\n(?=\*\*|- )/).flatMap((block) => {
    const label = /^\*\*(.+?)\*\*/.exec(block.trim())?.[1];
    const quotes = quoteBlocks(block);
    return label && quotes.length ? [{ label, quotes }] : [];
  });
}

function applicationsOf(text: string | undefined): CaptureApplication[] {
  const out: CaptureApplication[] = [];
  for (const line of (text ?? "").split("\n")) {
    const m = /^- \*\*(\w+):\*\*\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, key, raw] = m;
    if (key === "Applied") {
      out.push({ date: raw!.trim(), commit: null, target: null, note: null, outcome: null });
      continue;
    }
    const entry = out[out.length - 1];
    if (!entry) continue;
    const v = value(raw);
    if (key === "Commit") entry.commit = v;
    else if (key === "Target") entry.target = v;
    else if (key === "Note") entry.note = v;
    else if (key === "Outcome") entry.outcome = v;
  }
  return out;
}

/** Links to other captures in the knowledge repo; anything else (other folders, URLs) is dropped. */
function linksOf(text: string | undefined): CaptureLink[] {
  return bullets(text).flatMap((item) => {
    const m = /^\[([^\]]*)\]\((?:\.\.\/)?(inbox|applied|archived)\/([^)/]+)\)(?:\s+—\s+(.*))?$/.exec(item);
    const name = m && captureName(m[3]);
    return m && name ? [{ name, slug: m[1]!, note: m[4]?.trim() || null }] : [];
  });
}

/** The capture page's fields from a capture file. */
export function parseCaptureFile(content: string): CaptureFileFields {
  const { fields, body } = frontmatter(content.replace(/\r\n/g, "\n"));
  const own = ownPart(body);
  const s = sections(own);
  const url = value(fields.get("url"));
  return {
    title: /^# (.+)$/m.exec(own)?.[1]?.trim() || value(fields.get("source")) || "Untitled capture",
    date: fields.get("date") ?? "",
    type: value(fields.get("type")),
    // The oldest captures carry their tags as `modes:`.
    tags: (fields.get("tags") ?? fields.get("modes") ?? "").split(",").map((t) => t.trim()).filter(Boolean),
    url: url && /^https?:\/\//i.test(url) ? url : null,
    lowConfidence: fields.get("lowConfidence") === "true",
    coreIdea: value(s.get("Core idea")),
    takeaways: bullets(s.get("Key takeaways")),
    quotes: quoteBlocks(s.get("Quotes")),
    advice: value(s.get("Applied to")),
    where: whereOf(s.get("Where it applies")),
    evidence: evidenceOf(s.get("Evidence")),
    applications: applicationsOf(s.get("Application log")),
    links: linksOf(s.get("Links to memory")),
  };
}
