"use client";

import { useState } from "react";
import { handoffStatus, type HandoffState } from "@/lib/handoff-status";

const REASONS = [
  { reason: "wrong-files", label: "Wrong files" },
  { reason: "doesnt-fit", label: "Doesn't fit this repo" },
  { reason: "other", label: "Other" },
] as const;

const today = () => new Date().toISOString().slice(0, 10);

/**
 * The capture card's handoff, per repo: the Hand off button when the capture
 * isn't queued there, or what happened to it (sent, snoozed, no answer,
 * declined, applied) when it is. "Not a fit" answers a handoff from the web,
 * with the same reasons a coding agent sends. The best repo comes first;
 * "also fits" repos are in the switcher.
 */
export default function HandOff({ filename, repos, handoffs = [], files = [] }: {
  filename: string;
  repos: string[];
  handoffs?: HandoffState[];
  /** The files xkg suggested in the best repo (repos[0]), named by a "Wrong files" answer there. */
  files?: string[];
}) {
  const [repo, setRepo] = useState(repos[0]!);
  const [rows, setRows] = useState<HandoffState[]>(handoffs);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState("");

  const row = rows.find((r) => r.repo.toLowerCase() === repo.toLowerCase()) ?? null;
  const shown = handoffStatus(row);
  const setRow = (next: HandoffState) => setRows((all) => [next, ...all.filter((r) => r.repo.toLowerCase() !== next.repo.toLowerCase())]);

  async function send(url: string, body: Record<string, string | string[] | undefined>, fallback: string): Promise<{ status?: string } | null> {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json().catch(() => ({}))) as { status?: string; error?: string };
      if (!res.ok) {
        setError(data.error ?? fallback);
        return null;
      }
      return data;
    } catch {
      setError(fallback);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function handOff() {
    const data = await send("/api/handoffs", { filename, repo }, "Couldn't hand it off. Try again in a moment.");
    if (!data) return;
    if (data.status === "pending") setRow({ repo, status: "pending", since: today() });
    else setError(`Not queued: HANDOFFS.md marks it ${data.status} in ${repo}.`);
  }

  async function decline(reason: string) {
    const named: { files?: string[] } = reason === "wrong-files" && repo === repos[0] && files.length ? { files } : {};
    const data = await send("/api/handoffs/answer", { filename, repo, reason, ...named }, "Couldn't save your answer. Try again in a moment.");
    setAsking(false);
    if (data) setRow({ repo, status: "declined", since: row?.since ?? today() });
  }

  return (
    <div className="stack-2 pt-1">
      {repos.length > 1 && (
        <select
          aria-label="Repo to hand off to"
          value={repo}
          onChange={(e) => { setRepo(e.target.value); setError(""); setAsking(false); }}
          className="field w-full min-w-0 rounded-xl px-3 py-2.5 text-base focus:outline-hidden"
        >
          {repos.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      )}
      {shown.text && (
        <p className="text-sm leading-relaxed flex flex-wrap items-center gap-x-2 gap-y-1" style={{ color: "var(--fg)" }}>
          <span data-testid="handoff-chip" className="status-pill">{shown.chip}</span>
          <span className="min-w-0">{shown.text}</span>
        </p>
      )}
      {shown.canHandOff && (
        <button onClick={handOff} disabled={busy} aria-busy={busy} className="btn-secondary w-full py-2.5 rounded-xl font-medium text-sm">
          Hand off to your coding agent
        </button>
      )}
      {shown.canDecline && !asking && (
        <button type="button" onClick={() => { setAsking(true); setError(""); }} disabled={busy}
          className="inline-flex items-center self-start min-h-11 text-sm font-medium" style={{ color: "var(--fg-muted)" }}>
          Not a fit
        </button>
      )}
      {asking && (
        <div role="group" aria-label="Why it's not a fit" className="flex flex-wrap gap-2">
          {REASONS.map((r) => (
            <button key={r.reason} type="button" onClick={() => void decline(r.reason)} disabled={busy} aria-busy={busy}
              className="inline-flex items-center min-h-11 px-4 rounded-full text-sm font-medium"
              style={{ color: "var(--fg)", border: "1px solid var(--gold-low)" }}>
              {r.label}
            </button>
          ))}
          <button type="button" onClick={() => setAsking(false)} disabled={busy}
            className="inline-flex items-center min-h-11 px-2 text-sm" style={{ color: "var(--fg-muted)" }}>
            Cancel
          </button>
        </div>
      )}
      {error && <p role="alert" className="text-xs leading-relaxed" style={{ color: "var(--danger)" }}>{error}</p>}
    </div>
  );
}
