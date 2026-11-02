/**
 * Why and Impact for each file in a capture's "Where it applies": one short
 * call on the user's own model, from the capture and the files' paths,
 * one-line summaries and exported names only (never code). The lines are
 * written back into the capture file as "- `path`: why · Impact: impact", so
 * each capture is paid for once and every page and agent reads the same lines.
 * Older captures hold "· After:" lines; those are rewritten once as Impact.
 */

import { callLlm, llmSettings, type LlmUsage } from "@/lib/llm";
import type { LlmSettings } from "@/lib/types";
import { listCodeMaps, type User } from "@/lib/db";
import type { MapFile, StoredCodeMap } from "@/lib/code-map";
import { parseCaptureFile } from "@/lib/capture-detail";
import { MATCH_REPOS, codeSpan, nameCheck, readCodeSpan } from "@/lib/where";

/** Output cap for the call: three files × (path + a 12-word why + a 20-word impact) fits. */
export const EXPLAIN_MAX_TOKENS = 260;
export const MAX_LINE_WORDS = 12;
export const MAX_IMPACT_WORDS = 20;

export type ExplainedFile = { path: string; why: string; impact: string };

export const EXPLAIN_SYSTEM = `You explain where a saved piece of outside knowledge (a capture) applies in the user's code. You see the capture and, for each file, its path, a one-line summary when there is one, and the names it exports. You never see code.

For each file, write:
- why: what in the capture touches this file, in ${MAX_LINE_WORDS} words or fewer.
- impact: the result once the capture is applied: what works differently for the user or the codebase, and the outcome to expect. ${MAX_IMPACT_WORDS} words or fewer, one sentence.
Write impact for a busy reader: the outcome first, plain words, one idea. Name a behavior or a result, not only a renamed function. Present tense: no "can", "could", "may" or "would". If the capture doesn't touch a file, say so in why and write "No change" as impact. No filler. Put in backticks only names that file exports. Use only the paths given.

Reply with JSON only: {"files":[{"path":"...","why":"...","impact":"..."}]}`;

export function explainPrompt(
  capture: { title: string; coreIdea: string | null; takeaways: string[] },
  repo: string,
  files: MapFile[],
): string {
  const lines = files.map((f) => `- ${f.p}${f.d ? `: ${f.d}` : ""}${f.e?.length ? ` (exports: ${f.e.join(", ")})` : ""}`);
  return `Capture: ${capture.title}
Core idea: ${capture.coreIdea ?? ""}
Takeaways:
${capture.takeaways.slice(0, 3).map((t) => `- ${t}`).join("\n")}

Repo: ${repo}
Files:
${lines.join("\n")}`;
}

function parseReply(raw: string): unknown {
  const text = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  for (const candidate of [text, /\{[\s\S]*\}/.exec(text)?.[0]]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next form
    }
  }
  return undefined;
}

const STRING = String.raw`"((?:[^"\\]|\\.)*)"`;
const ITEM = new RegExp(String.raw`\{\s*"path"\s*:\s*${STRING}\s*,\s*"why"\s*:\s*${STRING}\s*,\s*"(?:impact|after)"\s*:\s*${STRING}`, "g");

/** The entries of a reply that isn't valid JSON (a stray comma or field), read one by one. */
function looseItems(raw: string): { path: string; why: string; impact: string }[] {
  const str = (s: string) => {
    try {
      return JSON.parse(`"${s}"`) as string;
    } catch {
      return "";
    }
  };
  return [...raw.matchAll(ITEM)].map((m) => ({ path: str(m[1]!), why: str(m[2]!), impact: str(m[3]!) }));
}

/** One line, at most `words` words, without the " · " the file line uses as a separator. */
function tidy(text: unknown, words: number): string {
  if (typeof text !== "string") return "";
  return text.replace(/\s+/g, " ").replace(/ · /g, " - ").trim().split(" ").slice(0, words).join(" ");
}

/** The model's reply as lines for the asked files; an entry missing either line, or naming something its file doesn't export, is dropped. */
export function checkExplain(raw: string, files: MapFile[]): ExplainedFile[] {
  const reply = parseReply(raw) as { files?: unknown } | undefined;
  const items = Array.isArray(reply?.files) ? reply.files : reply === undefined ? looseItems(raw) : [];
  const out: ExplainedFile[] = [];
  for (const item of items) {
    const r = item as Record<string, unknown> | null;
    const file = files.find((f) => f.p === r?.path);
    if (!file || out.some((o) => o.path === file.p)) continue;
    const why = tidy(r?.why, MAX_LINE_WORDS);
    // A model that ignores the rename may still answer with "after".
    const impact = tidy(r?.impact ?? r?.after, MAX_IMPACT_WORDS);
    if (!why || !impact || !nameCheck(why, file) || !nameCheck(impact, file)) continue;
    out.push({ path: file.p, why, impact });
  }
  return out;
}

/** Start and end of the "## Where it applies" section right after "## Core idea", or null. */
function whereBounds(markdown: string): [number, number] | null {
  const core = /^## Core idea\n/m.exec(markdown);
  if (!core) return null;
  const start = markdown.indexOf("\n## ", core.index + core[0].length) + 1;
  if (start === 0 || !markdown.startsWith("## Where it applies\n", start)) return null;
  const end = markdown.indexOf("\n## ", start);
  return [start, end < 0 ? markdown.length : end];
}

/** The capture file with each explained file's line in its "Where it applies" section rewritten; other text unchanged. */
export function setWhyImpact(markdown: string, files: ExplainedFile[]): string {
  const bounds = whereBounds(markdown);
  if (!bounds) return markdown;
  const [start, end] = bounds;
  const section = markdown
    .slice(start, end)
    .split("\n")
    .map((line) => {
      if (!line.startsWith("- `")) return line;
      const path = readCodeSpan(line.slice(2));
      const f = path && files.find((x) => x.path === path);
      return f ? `- ${codeSpan(f.path)}: ${f.why} · Impact: ${f.impact}` : line;
    })
    .join("\n");
  return markdown.slice(0, start) + section + markdown.slice(end);
}

/**
 * The user's provider and model, at low effort: two short lines per file need
 * little reasoning, and on a reasoning model low effort roughly halves the
 * output tokens. Effort is only lowered where the user set one (so the model
 * takes it) or on OpenAI (which sends it to reasoning models only).
 */
export function explainLlm(user: Pick<User, "llm_provider" | "llm_model" | "llm_effort">): LlmSettings {
  const llm = llmSettings(user);
  return llm.effort || llm.provider === "openai" ? { ...llm, effort: "low" } : llm;
}

type ExplainUser = Pick<User, "id" | "llm_api_key" | "llm_provider" | "llm_model" | "llm_effort">;

export interface ExplainDeps {
  complete?: (system: string, prompt: string, maxTokens: number, onUsage?: (usage: LlmUsage) => void) => Promise<string>;
  listMaps?: (userId: number) => Promise<StoredCodeMap[]>;
}

export interface Explained {
  files: ExplainedFile[];
  /** The capture file with the lines written in (unchanged when nothing new was explained). */
  markdown: string;
  /** Tokens the call used; absent when no call was made or the provider sent no count. */
  tokens?: { in: number; out: number };
}

/**
 * Why and Impact for the files of a capture with a fit. Files that already
 * have an Impact are kept and not asked about again; files with an old
 * "· After:" line are asked again once. Null when the capture has no fit, the
 * user has no model key, or the call failed.
 */
export async function explainCapture(user: ExplainUser, markdown: string, deps: ExplainDeps = {}): Promise<Explained | null> {
  const capture = parseCaptureFile(markdown);
  const where = capture.where;
  if (!where?.repo || !where.files.length) return null;
  const isDone = (f: (typeof where.files)[number]): f is ExplainedFile & typeof f => Boolean(f.why && f.impact && !f.legacy);
  const done = where.files.filter(isDone);
  if (done.length === where.files.length) return { files: done, markdown };
  if (!user.llm_api_key) return null;
  const apiKey = user.llm_api_key;

  const complete =
    deps.complete ??
    ((system: string, prompt: string, maxTokens: number, onUsage?: (usage: LlmUsage) => void) =>
      callLlm({ llm: explainLlm(user), apiKey, system, user: prompt, maxTokens, onUsage }));
  const listMaps = deps.listMaps ?? ((id: number) => listCodeMaps(id, MATCH_REPOS));

  try {
    const map = (await listMaps(user.id).catch(() => [])).find((m) => m.repo === where.repo);
    const todo = where.files
      .filter((f) => !isDone(f))
      .map((f) => map?.files.find((m) => m.p === f.path) ?? { p: f.path });
    let usage: LlmUsage | null = null;
    const raw = await complete(EXPLAIN_SYSTEM, explainPrompt(capture, where.repo, todo), EXPLAIN_MAX_TOKENS, (u) => { usage = u; });
    const fresh = checkExplain(raw, todo);
    // Nothing usable (empty, cut off or rejected): a failure the user can retry.
    if (!fresh.length) return null;
    const files = where.files.flatMap((f) => {
      const line = isDone(f) ? { path: f.path, why: f.why, impact: f.impact } : fresh.find((x) => x.path === f.path);
      return line ? [line] : [];
    });
    const tokens = usage ? { in: (usage as LlmUsage).tokensIn, out: (usage as LlmUsage).tokensOut } : undefined;
    return { files, markdown: fresh.length ? setWhyImpact(markdown, fresh) : markdown, ...(tokens ? { tokens } : {}) };
  } catch (err) {
    console.error("[explain] failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
