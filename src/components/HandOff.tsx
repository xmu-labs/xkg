"use client";

import { useState } from "react";
import { handoffStatus, type HandoffState } from "@/lib/handoff-status";

const today = () => new Date().toISOString().slice(0, 10);

/**
 * The capture card's handoff, per repo: the Hand off button when the capture
 * isn't queued there, or what happened to it (sent, snoozed, no answer,
 * declined, applied) when it is. It never asks the user to decline: judging
 * fit is xkg's job, and a no comes from the coding agent's offer (XKG-187).
 * The best repo comes first; "also fits" repos are in the switcher.
 */
export default function HandOff({ filename, repos, handoffs = [] }: {
  filename: string;
  repos: string[];
  handoffs?: HandoffState[];
}) {
  const [repo, setRepo] = useState(repos[0]!);
  const [rows, setRows] = useState<HandoffState[]>(handoffs);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const row = rows.find((r) => r.repo.toLowerCase() === repo.toLowerCase()) ?? null;
  const shown = handoffStatus(row);
  const setRow = (next: HandoffState) => setRows((all) => [next, ...all.filter((r) => r.repo.toLowerCase() !== next.repo.toLowerCase())]);

  async function send(url: string, body: Record<string, string>, fallback: string): Promise<{ status?: string } | null> {
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

  return (
    <div className="stack-2 pt-1">
      {repos.length > 1 && (
        <select
          aria-label="Repo to hand off to"
          value={repo}
          onChange={(e) => { setRepo(e.target.value); setError(""); }}
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
      {error && <p role="alert" className="text-xs leading-relaxed" style={{ color: "var(--danger)" }}>{error}</p>}
    </div>
  );
}
