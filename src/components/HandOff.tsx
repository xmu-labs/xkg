"use client";

import { useState } from "react";

/**
 * The capture card's handoff: queues the capture for the next coding session
 * in a repo. The best repo comes first; "also fits" repos are in the switcher.
 */
export default function HandOff({ filename, repos, waitingIn }: { filename: string; repos: string[]; waitingIn?: string }) {
  const [repo, setRepo] = useState(repos[0]!);
  const [waiting, setWaiting] = useState<string[]>(waitingIn ? [waitingIn] : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handOff() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/handoffs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename, repo }),
      });
      const data = (await res.json().catch(() => ({}))) as { status?: string; error?: string };
      if (!res.ok) setError(data.error ?? "Couldn't hand it off. Try again in a moment.");
      else if (data.status === "pending") setWaiting((w) => [...w, repo]);
      else setError(`Not queued: HANDOFFS.md marks it ${data.status} in ${repo}.`);
    } catch {
      setError("Couldn't hand it off. Try again in a moment.");
    } finally {
      setBusy(false);
    }
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
      {waiting.includes(repo) ? (
        <p className="text-sm leading-relaxed" style={{ color: "var(--fg)" }}>Waiting for your next session in {repo}</p>
      ) : (
        <button
          onClick={handOff}
          disabled={busy}
          aria-busy={busy}
          className="btn-secondary w-full py-2.5 rounded-xl font-medium text-sm"
        >
          Hand off to your coding agent
        </button>
      )}
      {error && <p role="alert" className="text-xs leading-relaxed" style={{ color: "var(--danger)" }}>{error}</p>}
    </div>
  );
}
