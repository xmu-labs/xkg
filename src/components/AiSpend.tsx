"use client";

import { useEffect, useState } from "react";
import { spendLine, type SpendSummary } from "@/lib/spend-format";

/**
 * Settings → AI model: what xkg spent with the user's key this month. An
 * estimate from list prices, and only xkg's own calls, so it says both.
 * Shows nothing when the numbers can't be loaded.
 */
export default function AiSpend() {
  const [month, setMonth] = useState<SpendSummary | null>(null);

  useEffect(() => {
    let live = true;
    void fetch("/api/spend")
      .then(async (res) => (res.ok ? ((await res.json()) as { month?: SpendSummary }) : null))
      .then((data) => { if (live && data?.month) setMonth(data.month); })
      .catch(() => { /* the line is optional */ });
    return () => { live = false; };
  }, []);

  if (!month) return null;
  return (
    <p data-testid="ai-spend" className="text-xs leading-relaxed" style={{ color: "var(--fg-muted)" }}>
      <span style={{ color: "var(--fg)" }}>{spendLine(month)}</span>{" "}
      Estimate from list prices, counting only what xkg spends with this key.
    </p>
  );
}
