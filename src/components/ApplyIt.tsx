"use client";

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
  style?: React.CSSProperties;
}

const FIT_TONE: Record<Fit, string> = { "Strong fit": "strong", "Possible fit": "possible" };

/** Text with `backticked` names shown as code. */
function withCode(text: string) {
  return text.split("`").map((part, i) => (i % 2 ? <code key={i} className="font-mono text-[12px]">{part}</code> : part));
}

const DEFAULT_NOTE = "From file names. Your coding agent checks the code.";

/**
 * Where and how a capture applies: the fit and the files in the user's code,
 * or the capture's general advice when nothing fits. Renders nothing when
 * there is neither.
 */
export default function ApplyIt({ where, advice, handoff, style }: ApplyItProps) {
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
          {where.also && where.also.length > 0 && (
            <p className="text-sm leading-relaxed" style={{ color: "var(--fg-muted)" }}>
              Also fits: {where.also.map((a) => `${a.repo} (${a.fit})`).join(", ")}
            </p>
          )}
          {handoff && <HandOff {...handoff} />}
          <p className="text-xs leading-relaxed" style={{ color: "var(--fg-muted)" }}>{where.note ?? DEFAULT_NOTE}</p>
        </>
      ) : (
        <p className="text-sm leading-relaxed" style={{ color: "var(--fg-muted)" }}>{advice}</p>
      )}
    </div>
  );
}
