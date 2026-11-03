"use client";

import { useEffect, useState } from "react";
import { spendLine, type SpendSummary } from "@/lib/spend-format";

/**
 * Settings → AI model: what xkg spent with the user's key this month, and an
 * optional monthly budget the home page warns about (XKG-145). The figure is
 * an estimate from list prices, and only xkg's own calls, so it says both.
 * Shows nothing when the numbers can't be loaded.
 */
export default function AiSpend({ inputClass }: { inputClass: string }) {
  const [month, setMonth] = useState<SpendSummary | null>(null);
  const [budget, setBudget] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "cleared" | "error">("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    void fetch("/api/spend")
      .then(async (res) => (res.ok ? ((await res.json()) as { month?: SpendSummary; budgetUsd?: number | null }) : null))
      .then((data) => {
        if (!live || !data?.month) return;
        setMonth(data.month);
        if (typeof data.budgetUsd === "number") setBudget(String(data.budgetUsd));
      })
      .catch(() => { /* the line is optional */ });
    return () => { live = false; };
  }, []);

  async function save() {
    setStatus("saving");
    setError("");
    // Empty clears; a number is sent as one; anything else goes as typed so the server's message explains it.
    const typed = budget.trim();
    const value = typed === "" ? null : Number.isFinite(Number(typed)) ? Number(typed) : typed;
    try {
      const res = await fetch("/api/spend", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ budgetUsd: value }),
      });
      const data = (await res.json().catch(() => ({}))) as { budgetUsd?: number | null; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't save the budget. Try again.");
      setBudget(typeof data.budgetUsd === "number" ? String(data.budgetUsd) : "");
      setStatus(data.budgetUsd == null ? "cleared" : "saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the budget. Try again.");
      setStatus("error");
    }
  }

  if (!month) return null;
  return (
    <div className="stack-2">
      <p data-testid="ai-spend" className="text-xs leading-relaxed" style={{ color: "var(--fg-muted)" }}>
        <span style={{ color: "var(--fg)" }}>{spendLine(month)}</span>{" "}
        Estimate from list prices, counting only what xkg spends with this key.
      </p>
      <div>
        <label htmlFor="ai-budget" className="text-xs font-medium" style={{ color: "var(--fg)" }}>
          Monthly budget (USD)
        </label>
        <div className="flex gap-2 mt-1.5">
          <input
            id="ai-budget"
            type="text"
            inputMode="decimal"
            placeholder="No budget"
            autoComplete="off"
            value={budget}
            onChange={(e) => { setBudget(e.target.value); setStatus("idle"); }}
            className={`${inputClass} min-w-0 flex-1`}
          />
          <button
            type="button"
            onClick={() => void save()}
            disabled={status === "saving"}
            className="shrink-0 text-sm font-medium rounded-xl px-3 disabled:opacity-30"
            style={{ color: "var(--fg)", border: "1px solid var(--gold-mid)" }}
          >
            Save budget
          </button>
        </div>
        {status === "error" ? (
          <p role="alert" className="text-xs leading-relaxed mt-1.5" style={{ color: "var(--danger)" }}>{error}</p>
        ) : (
          <p className="text-xs leading-relaxed mt-1.5" style={{ color: "var(--fg-muted)" }}>
            {status === "saved" ? "Budget saved. " : status === "cleared" ? "Budget cleared. " : ""}
            Home warns you at 80% and 100%. Captures keep working; only your provider can stop charges.
          </p>
        )}
      </div>
    </div>
  );
}
