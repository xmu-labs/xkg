"use client";

import { useEffect, useState } from "react";
import { budgetAlert, type BudgetAlert, type SpendSummary } from "@/lib/spend-format";
import { PROVIDERS, type LlmProvider } from "@/lib/providers";

/** Remembers a dismissed alert per month and level, so "over" still shows after "near" was dismissed. */
const seenKey = (alert: BudgetAlert) => `xkg-budget-alert:${new Date().toISOString().slice(0, 7)}:${alert.level}`;

function wasDismissed(alert: BudgetAlert): boolean {
  try { return localStorage.getItem(seenKey(alert)) === "1"; } catch { return false; /* storage blocked: show it */ }
}

/**
 * Home page warning when this month's estimated spend reaches 80% or 100% of
 * the user's own budget (Settings → AI model). A warning only: captures keep
 * working, and the billing link goes to the provider, which alone can stop
 * charges. Shows nothing without a budget or when spend can't be loaded.
 */
export default function BudgetBanner({ provider }: { provider?: LlmProvider }) {
  const [alert, setAlert] = useState<BudgetAlert | null>(null);

  useEffect(() => {
    let live = true;
    void fetch("/api/spend")
      .then(async (res) => (res.ok ? ((await res.json()) as { month?: SpendSummary; budgetUsd?: number | null }) : null))
      .then((data) => {
        if (!live || !data?.month) return;
        const next = budgetAlert(data.month, data.budgetUsd ?? null);
        if (next && !wasDismissed(next)) setAlert(next);
      })
      .catch(() => { /* the banner is optional */ });
    return () => { live = false; };
  }, []);

  if (!alert) return null;

  function dismiss() {
    if (!alert) return;
    try { localStorage.setItem(seenKey(alert), "1"); } catch { /* hidden for this visit only */ }
    setAlert(null);
  }

  const billing = provider ? PROVIDERS[provider] : null;
  return (
    <section
      aria-label="AI budget"
      className="w-full rounded-2xl p-4 mb-6 stack-2 wrap-anywhere"
      style={{ background: "var(--card-bg)", border: `1px solid ${alert.level === "over" ? "var(--danger)" : "var(--gold-faint)"}` }}
    >
      <p className="eyebrow" style={{ color: alert.level === "over" ? "var(--danger)" : "var(--gold)" }}>AI budget</p>
      <p className="text-sm leading-relaxed" style={{ color: "var(--fg)" }}>{alert.text}</p>
      <div className="flex items-center justify-between gap-3 pt-1">
        {billing ? (
          <a href={billing.billingUrl} target="_blank" rel="noopener noreferrer" className="text-sm underline underline-offset-2" style={{ color: "var(--fg-muted)" }}>
            Open {billing.label} billing
          </a>
        ) : <span />}
        <button onClick={dismiss} className="text-sm font-medium shrink-0 px-3 py-1.5" style={{ color: "var(--gold)" }}>
          Got it
        </button>
      </div>
    </section>
  );
}
