"use client";

// Kept in sync with MIN_PIN_LENGTH in lib/pin.ts (the server is the real check).
const MIN_PIN_LENGTH = 6;

import { useState } from "react";
import BrandMark from "@/components/BrandMark";
import Backdrop from "@/components/Backdrop";

const INPUT_STYLE: React.CSSProperties = {
  background: "var(--input-bg)",
  border: "1px solid var(--gold-low)",
  color: "var(--fg)",
};

const CARD_STYLE: React.CSSProperties = {
  background: "var(--card-bg)",
  border: "1px solid var(--gold-faint)",
};

type Provider = "anthropic" | "openai" | "google";

const PROVIDERS: Record<Provider, { label: string; placeholder: string; keysUrl: string; blurb: string }> = {
  anthropic: {
    label: "Anthropic",
    placeholder: "sk-ant-...",
    keysUrl: "https://console.anthropic.com/settings/keys",
    blurb: "Powers Claude extraction.",
  },
  openai: {
    label: "OpenAI",
    placeholder: "sk-...",
    keysUrl: "https://platform.openai.com/api-keys",
    blurb: "Powers GPT extraction.",
  },
  google: {
    label: "Google",
    placeholder: "AIza...",
    keysUrl: "https://aistudio.google.com/app/apikey",
    blurb: "Powers Gemini extraction.",
  },
};

export default function OnboardPage() {
  const [repoName, setRepoName] = useState("xkg-knowledge");
  const [provider, setProvider] = useState<Provider>("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [pin, setPin] = useState("");
  // Private by default — the hub holds everything the user captures.
  const [isPublic, setIsPublic] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [result, setResult] = useState<{ repo: string; repoUrl: string; apiKey: string } | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  const providerInfo = PROVIDERS[provider];

  async function handleSubmit() {
    if (!repoName.trim() || !apiKey.trim() || pin.length < MIN_PIN_LENGTH) return;
    setStatus("loading");
    setErrorMsg("");

    try {
      const res = await fetch("/api/onboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoName: repoName.trim(), provider, apiKey: apiKey.trim(), pin, isPublic }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }

      const data = (await res.json()) as { repo: string; repoUrl: string; apiKey: string };
      setResult(data);
      setStatus("done");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Something went wrong");
      setStatus("error");
    }
  }

  if (status === "done" && result) {
    return (
      <main className="min-h-dvh flex flex-col items-center justify-center px-4">
        <Backdrop />
        <div className="w-full max-w-sm stack-6">
          <div className="flex flex-col items-center mb-2">
            <div className="text-4xl mb-4">✓</div>
            <h1 className="text-lg font-semibold tracking-tight" style={{ color: "var(--fg)" }}>
              You&apos;re all set
            </h1>
          </div>

          <div className="rounded-2xl p-4 stack-3" style={CARD_STYLE}>
            <div>
              <p className="text-[10px] font-medium uppercase tracking-widest mb-1" style={{ color: "var(--gold)" }}>Knowledge repo</p>
              <a href={result.repoUrl} target="_blank" rel="noopener noreferrer"
                className="text-sm underline" style={{ color: "var(--fg)" }}>
                {result.repo}
              </a>
            </div>
            <div>
              <p className="text-[10px] font-medium uppercase tracking-widest mb-1" style={{ color: "var(--gold)" }}>Your API key</p>
              <code className="text-xs block p-2 rounded-lg break-all" style={{ background: "var(--input-bg)", color: "var(--fg-muted)" }}>
                {result.apiKey}
              </code>
              <p className="text-[10px] mt-1" style={{ color: "var(--fg-muted)" }}>
                Save this — it won&apos;t be shown again.
              </p>
            </div>
            <div>
              <p className="text-[10px] font-medium uppercase tracking-widest mb-1" style={{ color: "var(--gold)" }}>Connect with your AI worker</p>
              <code className="text-xs block p-2 rounded-lg break-all" style={{ background: "var(--input-bg)", color: "var(--fg-muted)" }}>
                npx -y @xmu-labs/xkg@latest serve-mcp --key {result.apiKey}
              </code>
            </div>
          </div>

          <a
            href="/"
            className="w-full py-3.5 rounded-2xl font-medium text-sm transition-all flex items-center justify-center"
            style={{ background: "var(--btn)", color: "var(--btn-fg)", textDecoration: "none" }}
          >
            Start capturing
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-dvh flex flex-col items-center justify-center px-4">
      <Backdrop />
      <div className="w-full max-w-sm stack-4">

        <div className="flex flex-col items-center mb-6">
          <BrandMark size={144} variant="expressive" className="-my-6" />
          <h1 className="text-lg font-semibold tracking-tight" style={{ color: "var(--fg)" }}>
            Set up your knowledge hub
          </h1>
          <p className="text-sm mt-1 text-center" style={{ color: "var(--fg-muted)" }}>
            Three things and you&apos;re capturing.
          </p>
        </div>

        {/* Step 1: Provider + API key */}
        <div className="rounded-2xl p-4 stack-2" style={CARD_STYLE}>
          <label className="text-[10px] font-medium uppercase tracking-widest" style={{ color: "var(--gold)" }}>
            LLM provider
          </label>
          <div className="grid grid-cols-3 gap-1.5">
            {(Object.keys(PROVIDERS) as Provider[]).map((p) => {
              const selected = provider === p;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setProvider(p)}
                  className="rounded-xl py-2 text-xs font-medium transition-all"
                  style={{
                    background: selected ? "var(--btn)" : "var(--input-bg)",
                    color: selected ? "var(--btn-fg)" : "var(--fg-muted)",
                    border: `1px solid ${selected ? "var(--btn)" : "var(--gold-low)"}`,
                  }}
                >
                  {PROVIDERS[p].label}
                </button>
              );
            })}
          </div>

          <label className="text-[10px] font-medium uppercase tracking-widest pt-1 block" style={{ color: "var(--gold)" }}>
            {providerInfo.label} API key
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={providerInfo.placeholder}
            className="w-full rounded-xl px-3 py-2.5 text-sm transition-colors focus:outline-hidden font-mono"
            style={INPUT_STYLE}
            onFocus={(e) => { e.currentTarget.style.borderColor = "var(--gold-high)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--gold-low)"; }}
          />
          <p className="text-[11px]" style={{ color: "var(--fg-muted)" }}>
            {providerInfo.blurb} <a href={providerInfo.keysUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--gold)", textDecoration: "underline" }}>Get yours here</a>. Your key, your cost — BYOK.
          </p>
        </div>

        {/* Step 2: Repo name */}
        <div className="rounded-2xl p-4 stack-2" style={CARD_STYLE}>
          <label className="text-[10px] font-medium uppercase tracking-widest" style={{ color: "var(--gold)" }}>
            Knowledge repo name
          </label>
          <input
            type="text"
            value={repoName}
            onChange={(e) => setRepoName(e.target.value)}
            placeholder="xkg-knowledge"
            className="w-full rounded-xl px-3 py-2.5 text-sm transition-colors focus:outline-hidden"
            style={INPUT_STYLE}
            onFocus={(e) => { e.currentTarget.style.borderColor = "var(--gold-high)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--gold-low)"; }}
          />
          <p className="text-[11px]" style={{ color: "var(--fg-muted)" }}>
            We&apos;ll create this repo on your GitHub. Your captures live here.
          </p>

          <label className="flex items-start gap-2.5 pt-1 cursor-pointer">
            <input
              type="checkbox"
              checked={isPublic}
              onChange={(e) => setIsPublic(e.target.checked)}
              className="mt-0.5 accent-current"
              style={{ accentColor: "var(--accent)" }}
            />
            <span className="text-[11px] leading-relaxed" style={{ color: "var(--fg-muted)" }}>
              Make this repo <strong>public</strong>
              <span className="block">
                Off by default — your hub is private, visible only to you. Turn this on
                only if you want everything you capture to be readable by anyone.
              </span>
            </span>
          </label>
        </div>

        {/* Step 3: PIN */}
        <div className="rounded-2xl p-4 stack-2" style={CARD_STYLE}>
          <label className="text-[10px] font-medium uppercase tracking-widest" style={{ color: "var(--gold)" }}>
            Set a PIN
          </label>
          <input
            type="password"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder={`Quick unlock PIN (min ${MIN_PIN_LENGTH} characters)`}
            minLength={MIN_PIN_LENGTH}
            className="w-full rounded-xl px-3 py-2.5 text-sm transition-colors focus:outline-hidden"
            style={INPUT_STYLE}
            onFocus={(e) => { e.currentTarget.style.borderColor = "var(--gold-high)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--gold-low)"; }}
          />
          <p className="text-[11px]" style={{ color: "var(--fg-muted)" }}>
            For quick access from your phone — no GitHub login needed.
          </p>
        </div>

        <button
          onClick={() => void handleSubmit()}
          disabled={!repoName.trim() || !apiKey.trim() || pin.length < MIN_PIN_LENGTH || status === "loading"}
          className="w-full py-3.5 rounded-2xl font-medium text-sm transition-all disabled:opacity-25 disabled:cursor-not-allowed"
          style={{ background: "var(--btn)", color: "var(--btn-fg)" }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "var(--btn-hover)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "var(--btn)"; }}
        >
          {status === "loading" ? (
            <span className="flex items-center justify-center gap-2">
              <span className="inline-block w-3.5 h-3.5 border-2 rounded-full animate-spin"
                style={{ borderColor: "var(--spinner-track)", borderTopColor: "var(--fg)" }} />
              Setting up...
            </span>
          ) : (
            "Create knowledge hub"
          )}
        </button>

        {status === "error" && (
          <p className="text-sm text-center" style={{ color: "var(--danger)" }}>{errorMsg}</p>
        )}
      </div>
    </main>
  );
}
