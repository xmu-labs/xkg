/**
 * A repo's code map as the server accepts it: file paths, exported names, their
 * signatures, links to other mapped files and each file's one-line doc
 * comment, never code. Built by the CLI (cli/code-map.ts)
 * where the coding agent runs; checked again here so the names-only promise
 * holds whatever a client sends.
 */

/** p path, e exported names, i mapped imports, d doc line, g signatures. */
export type MapFile = { p: string; e?: string[]; i?: string[]; d?: string; g?: string[] };
export interface CodeMapPayload {
  repo: string;
  head7: string;
  files: MapFile[];
  truncated: boolean;
}

/** Where a stored map came from: the CLI on the user's machine, or file names read from GitHub. */
export type CodeMapSource = "local" | "github";

/** A map as read back from storage, for matching captures to code. */
export interface StoredCodeMap {
  repo: string;
  files: MapFile[];
  head7: string | null;
  truncated: boolean;
  source?: CodeMapSource;
  syncedAt: Date;
}

export const MAX_MAP_FILES = 3000;
export const MAX_MAP_BODY_BYTES = 150 * 1024;
export const CODE_MAP_QUOTA = 60;

const REPO = /^[\w.-]+\/[\w.-]+$/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
export const MAX_DOC_LINE = 200;
export const MAX_SIGNATURE = 160;
export const MAX_SIGNATURES_PER_FILE = 30;
const ONE_LINE = /^[^\u0000-\u001f\u007f]+$/;
const line = (s: unknown, max: number): s is string => typeof s === "string" && s.length <= max && ONE_LINE.test(s);

function safePath(p: unknown): p is string {
  return typeof p === "string" && p.length > 0 && p.length <= 512 && !p.startsWith("/") &&
    !/[\0\\]/.test(p) && !p.split("/").some((seg) => seg === ".." || seg === "");
}

/** The payload reduced to what is stored, or the first reason it can't be. */
export function parseCodeMap(body: unknown): { ok: true; map: CodeMapPayload } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Body must be a JSON object." };
  const b = body as Record<string, unknown>;
  if (typeof b.repo !== "string" || b.repo.length > 200 || !REPO.test(b.repo)) {
    return { ok: false, error: "repo must look like owner/name." };
  }
  const head7 = b.head7 ?? "";
  if (typeof head7 !== "string" || (head7 !== "" && !/^[0-9a-f]{7}$/.test(head7))) {
    return { ok: false, error: "head7 must be 7 hex characters." };
  }
  if (b.truncated !== undefined && typeof b.truncated !== "boolean") return { ok: false, error: "truncated must be true or false." };
  if (!Array.isArray(b.files)) return { ok: false, error: "files must be a list." };
  if (b.files.length > MAX_MAP_FILES) return { ok: false, error: `A map holds at most ${MAX_MAP_FILES} files.` };

  const paths = new Set<string>();
  for (const f of b.files as unknown[]) {
    const p = (f as { p?: unknown } | null)?.p;
    if (!safePath(p)) return { ok: false, error: "Each file needs a relative path without '..'." };
    if (paths.has(p)) return { ok: false, error: `Duplicate path: ${p}` };
    paths.add(p);
  }

  const files: MapFile[] = [];
  for (const f of b.files as Array<Record<string, unknown>>) {
    const file: MapFile = { p: f.p as string };
    if (f.e !== undefined) {
      if (!Array.isArray(f.e) || f.e.length > 1000 || !f.e.every((n) => typeof n === "string" && n.length <= 200 && IDENTIFIER.test(n))) {
        return { ok: false, error: `Exported names of ${file.p} must be identifiers.` };
      }
      if (f.e.length) file.e = f.e as string[];
    }
    if (f.i !== undefined) {
      if (!Array.isArray(f.i) || !f.i.every((p) => typeof p === "string" && paths.has(p))) {
        return { ok: false, error: `Imports of ${file.p} must be paths in this map.` };
      }
      if (f.i.length) file.i = f.i as string[];
    }
    if (f.d !== undefined) {
      if (!line(f.d, MAX_DOC_LINE)) return { ok: false, error: `The doc line of ${file.p} must be one line of at most ${MAX_DOC_LINE} characters.` };
      file.d = f.d;
    }
    if (f.g !== undefined) {
      if (!Array.isArray(f.g) || f.g.length > MAX_SIGNATURES_PER_FILE || !f.g.every((g) => line(g, MAX_SIGNATURE))) {
        return { ok: false, error: `Signatures of ${file.p} must be at most ${MAX_SIGNATURES_PER_FILE} single lines of at most ${MAX_SIGNATURE} characters.` };
      }
      if (f.g.length) file.g = f.g as string[];
    }
    files.push(file);
  }
  // GitHub matches owner/name in any case, so one repo is one row however its remote is spelled.
  return { ok: true, map: { repo: b.repo.toLowerCase(), head7, files, truncated: b.truncated === true } };
}
