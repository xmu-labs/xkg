"use client";

import { useEffect, useState } from "react";
import { budgetAlert, SPEND_CHANGED_EVENT, type BudgetAlert, type SpendSummary } from "@/lib/spend-format";
import { PROVIDERS, type LlmProvider } from "@/lib/providers";
import { OPEN_SETTINGS_EVENT } from "./SettingsDrawer";

/**
 * Remembers a dismissed alert per account, month and level, so "over" still
 * shows after "near" was dismissed, and one account's dismissal never hides
 * another's warning on a shared browser.
 */
const seenKey = (user: string, alert: BudgetAlert) =>
  `xkg-budget-alert:${user.toLowerCase()}:${new Date().toISOString().slice(0, 7)}:${alert.level}`;

function wasDismissed(user: string, alert: BudgetAlert): boolean {
  try { return localStorage.getItem(seenKey(user, alert)) === "1"; } catch { return false; /* storage blocked: show it */ }
}

/**
 * Home page warning when this month's estimated spend reaches 80% or 100% of
 * the user's own budget (Settings → AI model). A warning only: captures keep
 * working, and the billing link goes to the provider, which alone can stop
 * charges. Shows nothing without a budget or when spend can't be loaded.
 */
export default function BudgetBanner({ user, provider }: { user?: string; provider?: LlmProvider }) {
  const [alert, setAlert] = useState<BudgetAlert | null>(null);

  // Read on load and again whenever a capture or a budget save changes the numbers.
  useEffect(() => {
    if (!user) return;
    const account = user;
    let live = true;
    let request = 0;
    function load() {
      const mine = ++request;
      void fetch("/api/spend")
        .then(async (res) => (res.ok ? ((await res.json()) as { month?: SpendSummary; budgetUsd?: number | null }) : null))
        .then((data) => {
          if (!live || mine !== request || !data?.month) return;
          const next = budgetAlert(data.month, data.budgetUsd ?? null);
          setAlert(next && !wasDismissed(account, next) ? next : null);
        })
        .catch(() => { /* the banner is optional */ });
    }
    load();
    window.addEventListener(SPEND_CHANGED_EVENT, load);
    return () => { live = false; window.removeEventListener(SPEND_CHANGED_EVENT, load); };
  }, [user]);

  if (!alert || !user) return null;
  const account = user;

  function dismiss() {
    if (!alert) return;
    try { localStorage.setItem(seenKey(account, alert), "1"); } catch { /* hidden for this visit only */ }
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
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1">
        {billing && (
          <a href={billing.billingUrl} target="_blank" rel="noopener noreferrer" className="text-sm underline underline-offset-2" style={{ color: "var(--fg-muted)" }}>
            Open {billing.label} billing
          </a>
        )}
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event(OPEN_SETTINGS_EVENT))}
          className="text-sm underline underline-offset-2"
          style={{ color: "var(--fg-muted)" }}
        >
          Change budget
        </button>
        <button onClick={dismiss} className="ml-auto text-sm font-medium shrink-0 px-3 py-1.5" style={{ color: "var(--gold)" }}>
          Got it
        </button>
      </div>
    </section>
  );
}
