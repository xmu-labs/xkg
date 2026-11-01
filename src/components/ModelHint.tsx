"use client";

import { useState } from "react";
import type { Me } from "./SettingsDrawer";
import type { CaptureUsage } from "@/lib/capture-stats";
import { speedRow } from "@/lib/model-speed";
import { nudgeKey, recommendFaster } from "@/lib/model-nudge";

/**
 * After a slow capture, offer the provider's measured fast model: one line,
 * Use (with Undo) or Keep mine. Fast captures, and setups the user kept, show
 * nothing. The offer is decided once, when the result arrives.
 */
export default function ModelHint({ usage, me, onMe }: { usage: CaptureUsage; me: Me; onMe: (me: Me) => void }) {
  const [nudge] = useState(() => {
    if (!me.llmProvider) return null;
    return recommendFaster({
      provider: me.llmProvider,
      model: usage.model,
      effort: me.llmEffort ?? null,
      extractMs: usage.extractMs,
      dismissedFor: me.modelNudgeDismissedFor,
      row: speedRow(me.llmProvider),
    });
  });
  // What Undo restores: the settings when the hint was shown.
  const [previous] = useState(() => settingsOf(me));
  // The settings the hint was decided for (then, after Use, the ones it saved).
  // If they change elsewhere, say in Settings, the offer and Undo no longer apply.
  const [expected, setExpected] = useState(() => settingsOf(me));
  // Kept for the setup the offer was shown for.
  const [key] = useState(() => nudgeKey(usage.model, me.llmEffort ?? null));
  const [phase, setPhase] = useState<"offer" | "switched" | "gone">("offer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!nudge || phase === "gone" || !sameSettings(settingsOf(me), expected)) return null;

  async function save(body: Record<string, unknown>, failed: string): Promise<Me | null> {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 401) {
        window.location.href = "/login";
        return null;
      }
      if (!res.ok) throw new Error();
      const next = await res.json() as Me;
      setExpected(settingsOf(next));
      onMe(next);
      return next;
    } catch {
      setError(failed);
      return null;
    } finally {
      setBusy(false);
    }
  }

  const use = async () => {
    const llmModel = nudge.model === me.defaultModel ? null : nudge.model;
    const saved = await save({ llmModel, llmEffort: null, modelNudgeDismissedFor: key },
      "Couldn't switch the model. Try again, or change it in Settings → AI model.");
    if (saved) setPhase("switched");
  };
  const keep = async () => {
    if (await save({ modelNudgeDismissedFor: key }, "Couldn't save that. Try again.")) setPhase("gone");
  };
  const undo = async () => {
    if (await save({ llmModel: previous.llmModel, llmEffort: previous.llmEffort }, "Couldn't undo. Change it in Settings → AI model.")) setPhase("gone");
  };

  const model = (id: string) => <span className="font-medium break-all" style={{ color: "var(--fg)" }}>{id}</span>;
  const button = "text-xs font-medium rounded-full px-3 py-1.5 disabled:opacity-60";
  const primary = { background: "var(--btn)", color: "var(--btn-fg)" };
  const quiet = { color: "var(--fg)", border: "1px solid var(--gold-low)" };

  return (
    <div data-testid="model-hint" className="rounded-2xl px-4 py-3 stack-2"
      style={{ background: "var(--card-bg)", border: "1px solid var(--gold-faint)" }}>
      {phase === "offer" ? (
        <>
          <p className="text-xs leading-relaxed" style={{ color: "var(--fg-muted)" }}>
            This took {nudge.tookSeconds} s. {model(nudge.model)} usually takes about {nudge.usualSeconds} s.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={button} style={primary} disabled={busy} onClick={() => void use()}>
              Use <span className="break-all">{nudge.model}</span>
            </button>
            <button type="button" className={button} style={quiet} disabled={busy} onClick={() => void keep()}>
              Keep mine
            </button>
          </div>
        </>
      ) : (
        <div className="flex items-center gap-3">
          <p className="text-xs leading-relaxed" style={{ color: "var(--fg-muted)" }}>Switched to {model(nudge.model)}.</p>
          <button type="button" className={`${button} ml-auto shrink-0`} style={quiet} disabled={busy} onClick={() => void undo()}>
            Undo
          </button>
        </div>
      )}
      {error && <p role="alert" className="text-xs" style={{ color: "var(--danger)" }}>{error}</p>}
    </div>
  );
}

type Settings = { provider: string | null; llmModel: string | null; llmEffort: string | null };

function settingsOf(me: Me): Settings {
  return { provider: me.llmProvider ?? null, llmModel: me.llmModel ?? null, llmEffort: me.llmEffort ?? null };
}

function sameSettings(a: Settings, b: Settings): boolean {
  return a.provider === b.provider && a.llmModel === b.llmModel && a.llmEffort === b.llmEffort;
}
