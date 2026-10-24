"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import BrandMark from "@/components/BrandMark";
import Backdrop from "@/components/Backdrop";
import { isHostedInstance } from "@/lib/hosted";


const CARD_STYLE: React.CSSProperties = {
  background: "var(--card-bg)",
  border: "1px solid var(--gold-faint)",
};

// Self-service account deletion redirects here with ?deleted=1 (and &revoke=1
// when GitHub couldn't confirm it revoked xkg). Read from the URL on the client
// only; the server render shows no notice.
function readDeleted(): null | "done" | "revoke" {
  const params = new URLSearchParams(window.location.search);
  if (params.get("deleted") !== "1") return null;
  return params.get("revoke") === "1" ? "revoke" : "done";
}
const noSubscribe = () => () => {};

export default function LoginPage() {
  const [showPin, setShowPin] = useState(false);
  const [pin, setPin] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  // PIN unlock only works on a device already verified through GitHub, so ask
  // the server whether to offer it rather than showing a form that can't work.
  const [pinAvailable, setPinAvailable] = useState(false);
  const [pinUser, setPinUser] = useState("");
  const deleted = useSyncExternalStore(noSubscribe, readDeleted, () => null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/auth");
        if (!res.ok) return;
        const data = (await res.json()) as { available?: boolean; username?: string };
        if (cancelled) return;
        setPinAvailable(data.available === true);
        setPinUser(data.username ?? "");
      } catch {
        // Offline or unreachable — leave PIN hidden; GitHub sign-in still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handlePinLogin() {
    if (!pin.trim()) return;
    setStatus("loading");
    setErrorMsg("");

    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });

      if (!res.ok) {
        let message = "Incorrect PIN.";
        try {
          const data = (await res.json()) as { error?: string; needsGithub?: boolean };
          if (data.error) message = data.error;
          // The device is no longer trusted — send them back to GitHub.
          if (data.needsGithub) setPinAvailable(false);
        } catch {
          // Non-JSON body: keep the default message.
        }
        setStatus("error");
        setErrorMsg(message);
        setPin("");
        return;
      }

      window.location.href = "/";
    } catch {
      setStatus("error");
      setErrorMsg("Something went wrong.");
      setPin("");
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") void handlePinLogin();
  }

  return (
    <main className="min-h-dvh flex flex-col items-center justify-center px-4">
      <Backdrop />
      <div className="w-full max-w-xs stack-4">

        {/* Logo + wordmark */}
        <div className="flex flex-col items-center text-center mb-10">
          <BrandMark size={208} variant="expressive" className="-my-10" />
          <h1 className="wordmark text-2xl" style={{ color: "var(--fg)" }}>xkg</h1>
          <p className="text-sm mt-1 max-w-[16rem]" style={{ color: "var(--fg-muted)" }}>
            Learn it once. Your AI applies it.
          </p>
        </div>

        {deleted && (
          <div role="status" className="rounded-2xl p-4 text-xs leading-relaxed" style={CARD_STYLE}>
            <p style={{ color: "var(--fg)" }}>
              Your xkg account has been deleted. Your captures are still in your GitHub repository.
            </p>
            {deleted === "revoke" && (
              <p className="mt-2" style={{ color: "var(--fg-muted)" }}>
                GitHub didn&apos;t confirm that xkg&apos;s access was revoked. To be sure, remove xkg under{" "}
                <a href="https://github.com/settings/applications" className="underline underline-offset-2">
                  GitHub → Settings → Applications
                </a>
                .
              </p>
            )}
          </div>
        )}

        {/* GitHub OAuth — primary */}
        <a
          href="/api/auth/github"
          className="btn-primary w-full py-3.5 rounded-2xl font-medium text-sm flex items-center justify-center gap-2"
          style={{ textDecoration: "none" }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
          </svg>
          Sign in with GitHub
        </a>

        {/* Divider — only when PIN unlock is actually possible here */}
        {pinAvailable && (
        <div className="flex items-center gap-3 py-2">
          <div className="flex-1 h-px" style={{ background: "var(--gold-faint)" }} />
          <span className="text-xs" style={{ color: "var(--fg-muted)" }}>or</span>
          <div className="flex-1 h-px" style={{ background: "var(--gold-faint)" }} />
        </div>
        )}

        {/* PIN quick-unlock — only on a device already verified via GitHub */}
        {pinAvailable && (!showPin ? (
          <button
            onClick={() => setShowPin(true)}
            className="btn-secondary w-full py-3 rounded-2xl font-medium text-sm"
          >
            Quick unlock with PIN
          </button>
        ) : (
          <div className="stack-2.5 rounded-2xl p-4" style={CARD_STYLE}>
            {pinUser && (
              <p className="text-xs text-center pb-0.5" style={{ color: "var(--fg-muted)" }}>
                Unlocking as <strong>{pinUser}</strong>
              </p>
            )}
            <input
              type="password"
              placeholder="PIN"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              onKeyDown={handleKeyDown}
              autoFocus
              className="field w-full rounded-xl px-3 py-2.5 text-base focus:outline-hidden"
            />
            <button
              onClick={() => void handlePinLogin()}
              disabled={!pin.trim() || status === "loading"}
              className="btn-primary w-full py-2.5 rounded-xl font-medium text-sm disabled:opacity-25"
            >
              {status === "loading" ? "Checking…" : "Unlock"}
            </button>
            {status === "error" && (
              <p className="text-xs text-center" style={{ color: "var(--danger)" }}>{errorMsg}</p>
            )}
          </div>
        ))}

        <p className="text-[11px] text-center pt-4" style={{ color: "var(--fg-muted)" }}>
          First time? Sign in with GitHub to get started.
        </p>
        {/* The hosted service's terms; a self-hosted copy has its own operator. */}
        {isHostedInstance() && (
          <p className="text-[11px] text-center" style={{ color: "var(--fg-muted)" }}>
            By signing in you agree to the{" "}
            <Link href="/terms" className="underline underline-offset-2">Terms</Link> and{" "}
            <Link href="/privacy" className="underline underline-offset-2">Privacy Policy</Link>.
          </p>
        )}
      </div>
    </main>
  );
}
