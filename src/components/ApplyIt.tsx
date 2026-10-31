"use client";

import { useEffect, useRef, useState } from "react";
import HandOff from "./HandOff";

export type Fit = "Strong fit" | "Possible fit";

export interface ApplyItWhere {
  fit: Fit;
  repo: string;
  files: { path: string; why?: string; after?: string }[];
  also?: { repo: string; fit: string }[];
  /** Where the match came from, e.g. "From file names, not yet checked in your code · map from …". */
  note?: string;
}

export interface ApplyItProps {
  /** The suggested files; null when nothing fits. */
  where: ApplyItWhere | null;
  /** The capture's general advice (`appliedTo`); shown when nothing fits. */
  advice: string | null;
  /** The hand-off button; left out on read-only pages. */
  handoff?: { filename: string; repos: string[]; waitingIn?: string };
  /**
   * Fills in Why and After for files that lack them: asked for by itself when
   * `auto` (Strong fit), else behind a "Why and how" button. `onRequest`
   * updates `where` and throws on failure.
   */
  explain?: { auto: boolean; onRequest: () => Promise<void> };
  style?: React.CSSProperties;
}

/**
 * The card's `where` from a "Where it applies" result (the capture result's
 * `where`, or the one parsed from a capture file): null when nothing fits or
 * there is none.
 */
export function applyWhere(w: { fit: string; repo: string | null; files: ApplyItWhere["files"]; also?: ApplyItWhere["also"]; note?: string } | null | undefined): ApplyItWhere | null {
  if (!w?.repo || (w.fit !== "Strong fit" && w.fit !== "Possible fit")) return null;
  return { fit: w.fit, repo: w.repo, files: w.files, also: w.also, note: w.note };
}

/**
 * Asks the server for Why and After on a capture's files and returns them
 * merged into `files`; throws when it fails.
 */
export async function explainFiles<F extends { path: string; why?: string; after?: string }>(name: string, files: F[]): Promise<F[]> {
  const res = await fetch("/api/captures/explain", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`explain ${res.status}`);
  const data = (await res.json()) as { files?: { path: string; why: string; after: string }[] };
  return files.map((f) => {
    const line = data.files?.find((x) => x.path === f.path);
    return line ? { ...f, why: line.why, after: line.after } : f;
  });
}

const FIT_TONE: Record<Fit, string> = { "Strong fit": "strong", "Possible fit": "possible" };

/** Text with `backticked` names shown as code. */
function withCode(text: string) {
  return text.split("`").map((part, i) => (i % 2 ? <code key={i} className="font-mono text-[12px]">{part}</code> : part));
}

/** Always this line: the stored note ("from file names, not yet checked … · map from …") reads as noise on the card. */
const NOTE = "Matched by file names. Your coding agent checks the code.";

/**
 * Where and how a capture applies: the fit and the files in the user's code,
 * or the capture's general advice when nothing fits. Renders nothing when
 * there is neither.
 */
export default function ApplyIt({ where, advice, handoff, explain, style }: ApplyItProps) {
  const needs = Boolean(explain && where?.files.some((f) => !f.after));
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");
  const asked = useRef(false);
  const run = () => {
    if (!explain) return;
    setState("loading");
    explain.onRequest().then(
      () => setState("idle"),
      () => setState("failed"),
    );
  };
  const latest = useRef(run);
  useEffect(() => {
    latest.current = run;
  });
  const auto = needs && explain?.auto;
  useEffect(() => {
    if (auto && !asked.current) {
      asked.current = true;
      latest.current();
    }
  }, [auto]);

  if (!where && !advice) return null;
  const tone = where ? FIT_TONE[where.fit] : null;
  return (
    <div
      data-testid="apply-it"
      data-reveal
      className="apply-it rounded-2xl p-4 stack-3"
      data-tone={tone ?? undefined}
      style={style}
    >
      <p className="eyebrow" style={{ color: "var(--gold)" }}>Apply it</p>
      {where ? (
        <>
          <p className="text-sm leading-relaxed flex flex-wrap items-center gap-x-2 gap-y-1">
            <span data-testid="fit" className="fit-pill">{where.fit}</span>
            <span className="min-w-0" style={{ color: "var(--fg-muted)" }}>in {where.repo}</span>
          </p>
          <ul className="stack-3">
            {where.files.map((f) => (
              <li key={f.path} className="stack-1 text-sm leading-relaxed" style={{ color: "var(--fg-muted)" }}>
                <code className="block font-mono text-[12px] break-all" style={{ color: "var(--fg)" }}>{f.path}</code>
                {f.why && <p>{f.after ? <><b className="font-medium" style={{ color: "var(--fg)" }}>Why:</b> </> : null}{withCode(f.why)}</p>}
                {f.after && <p><b className="font-medium" style={{ color: "var(--fg)" }}>After:</b> {withCode(f.after)}</p>}
              </li>
            ))}
          </ul>
          {needs && state === "loading" && (
            <p role="status" className="text-sm" style={{ color: "var(--fg-muted)" }}>Writing why and after…</p>
          )}
          {needs && state === "failed" && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <p role="alert" className="text-sm" style={{ color: "var(--danger)" }}>Couldn&apos;t explain these files.</p>
              <button type="button" onClick={run} className="min-h-11 text-sm font-medium" style={{ color: "var(--gold)" }}>
                Try again
              </button>
            </div>
          )}
          {needs && state === "idle" && !explain?.auto && (
            <button type="button" onClick={run} className="inline-flex items-center min-h-11 px-4 rounded-full text-sm font-medium"
              style={{ color: "var(--gold)", border: "1px solid var(--gold-low)" }}>
              Why and how
            </button>
          )}
          {where.also && where.also.length > 0 && (
            <p className="text-sm leading-relaxed" style={{ color: "var(--fg-muted)" }}>
              Also fits: {where.also.map((a) => `${a.repo} (${a.fit})`).join(", ")}
            </p>
          )}
          {handoff && <HandOff {...handoff} />}
          <p className="text-xs leading-relaxed" style={{ color: "var(--fg-muted)" }}>{NOTE}</p>
        </>
      ) : (
        <p className="text-sm leading-relaxed" style={{ color: "var(--fg-muted)" }}>{advice}</p>
      )}
    </div>
  );
}
