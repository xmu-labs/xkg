"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { POLICY_NOTICE, POLICY_SEEN_KEY } from "@/lib/policy-notice";

function readSeen(): string | null {
  try { return localStorage.getItem(POLICY_SEEN_KEY); } catch { return null; /* storage blocked: show it */ }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

/** A one-time notice about the latest material privacy change. */
export default function PolicyNotice() {
  // The server can't see localStorage, so it renders nothing and the browser
  // decides after hydration.
  const seen = useSyncExternalStore(subscribe, readSeen, () => POLICY_NOTICE.date);
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || seen === POLICY_NOTICE.date) return null;

  function dismiss() {
    setDismissed(true);
    try { localStorage.setItem(POLICY_SEEN_KEY, POLICY_NOTICE.date); } catch { /* hidden for this visit only */ }
  }

  return (
    <section
      aria-label="Privacy update"
      className="w-full rounded-2xl p-4 mb-6 stack-2 wrap-anywhere"
      style={{ background: "var(--card-bg)", border: "1px solid var(--gold-faint)" }}
    >
      <p className="eyebrow" style={{ color: "var(--gold)" }}>Privacy update</p>
      <p className="text-sm leading-relaxed" style={{ color: "var(--fg)" }}>{POLICY_NOTICE.text}</p>
      <div className="flex items-center justify-between gap-3 pt-1">
        <Link href="/privacy" className="text-sm underline underline-offset-2" style={{ color: "var(--fg-muted)" }}>
          Read the privacy policy
        </Link>
        <button onClick={dismiss} className="text-sm font-medium shrink-0 px-3 py-1.5" style={{ color: "var(--gold)" }}>
          Got it
        </button>
      </div>
    </section>
  );
}
