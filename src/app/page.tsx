"use client";

import { useState, useEffect, useRef } from "react";
import SettingsDrawer, { type Me } from "@/components/SettingsDrawer";
import BrandMark from "@/components/BrandMark";

interface CaptureResult {
  capture: {
    inferredTitle: string;
    coreIdea: string;
    takeaways: string[];
    quotes: string[];
    tags: string[];
    appliedTo: string | null;
    inferredType: string;
  };
  filename: string;
}

const TYPE_LABELS: Record<string, string> = {
  article: "Article",
  blog: "Blog",
  research: "Research",
  transcript: "Transcript",
  notes: "Notes",
  post: "Post",
  book: "Book",
};

const INPUT_CLASS =
  "w-full rounded-2xl px-4 py-3 text-base transition-colors focus:outline-hidden";

const INPUT_STYLE: React.CSSProperties = {
  background: "var(--input-bg)",
  border: "1px solid var(--gold-low)",
  color: "var(--fg)",
};

const CARD_STYLE: React.CSSProperties = {
  background: "var(--card-bg)",
  border: "1px solid var(--gold-faint)",
};

export default function CapturePage() {
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [result, setResult] = useState<CaptureResult | null>(null);
  const [error, setError] = useState("");
  const [newVersionAvailable, setNewVersionAvailable] = useState(false);
  const initialBuildId = useRef<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    async function checkVersion() {
      try {
        const res = await fetch("/api/version");
        if (!res.ok) return;
        const data = await res.json() as { buildId: string };
        if (!initialBuildId.current) {
          initialBuildId.current = data.buildId;
        } else if (data.buildId !== initialBuildId.current && data.buildId !== "unknown") {
          setNewVersionAvailable(true);
        }
      } catch { /* silently ignore network errors */ }
    }

    void checkVersion();
    const interval = setInterval(() => void checkVersion(), 60_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    void fetch("/api/me")
      .then(async (res) => {
        if (!res.ok) return;
        setMe(await res.json() as Me);
      })
      .catch(() => { /* ignore */ });
  }, []);

  async function handleSubmit() {
    if (!content.trim()) return;
    setStatus("loading");
    setResult(null);
    setError("");

    try {
      const res = await fetch("/api/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, title: title.trim() || undefined }),
      });

      if (!res.ok) {
        if (res.status === 401) {
          window.location.href = "/login";
          return;
        }
        let errorMsg = `HTTP ${res.status}`;
        try {
          const data = await res.json() as { error?: string };
          if (data.error) errorMsg = data.error;
        } catch { /* response was not JSON */ }
        throw new Error(errorMsg);
      }

      let data: CaptureResult;
      try {
        data = await res.json() as CaptureResult;
      } catch {
        throw new Error("Unexpected response from server. Please refresh and try again.");
      }
      setResult(data);
      setStatus("done");
      setContent("");
      setTitle("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setStatus("error");
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      void handleSubmit();
    }
  }

  function handleReset() {
    setStatus("idle");
    setResult(null);
    setError("");
  }

  return (
    <>
    {newVersionAvailable && (
      <div className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
        style={{ background: "var(--bg)", borderBottom: "1px solid var(--gold-low)" }}>
        <span style={{ color: "var(--fg-muted)" }}>A new version is available.</span>
        <button
          onClick={() => window.location.reload()}
          className="text-sm font-medium shrink-0"
          style={{ color: "var(--gold)" }}
        >
          Refresh now
        </button>
      </div>
    )}
    <main className="min-h-dvh flex flex-col items-center px-4 py-8 max-w-xl mx-auto" style={newVersionAvailable ? { paddingTop: "3rem" } : undefined}>

      {/* Header */}
      <div className="w-full mb-10">
        <div className="flex items-center gap-3 mb-1 overflow-visible">
          <BrandMark size={48} className="h-12 w-12" />
          <h1 className="text-base font-semibold tracking-tight" style={{ color: "var(--fg)" }}>xkg</h1>
          <SettingsDrawer me={me} onMe={setMe} newVersionAvailable={newVersionAvailable} />
        </div>
        <p className="text-sm pl-10" style={{ color: "var(--fg-muted)" }}>
          Find something. Use it with AI workers.
        </p>
      </div>

      {/* Capture form */}
      {status !== "done" && (
        <div className="w-full stack-2.5">
          <input
            type="text"
            placeholder="Title (optional — inferred if blank)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className={INPUT_CLASS}
            style={INPUT_STYLE}
            onFocus={(e) => { e.currentTarget.style.borderColor = "var(--gold-high)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--gold-low)"; }}
          />

          <textarea
            placeholder={"Paste anything — URL, article, thread, notes, transcript..."}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={9}
            className={INPUT_CLASS + " resize-none leading-relaxed"}
            style={INPUT_STYLE}
            onFocus={(e) => { e.currentTarget.style.borderColor = "var(--gold-high)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--gold-low)"; }}
          />

          <button
            onClick={() => void handleSubmit()}
            disabled={!content.trim() || status === "loading"}
            className="w-full py-3.5 rounded-2xl font-medium text-sm transition-all disabled:opacity-25 disabled:cursor-not-allowed"
            style={{ background: "var(--btn)", color: "var(--btn-fg)" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "var(--btn-hover)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "var(--btn)"; }}
          >
            {status === "loading" ? (
              <span className="flex items-center justify-center gap-2">
                <span className="inline-block w-3.5 h-3.5 border-2 rounded-full animate-spin"
                  style={{ borderColor: "var(--spinner-track)", borderTopColor: "var(--fg)" }} />
                Extracting insights...
              </span>
            ) : (
              <span className="flex items-center justify-center gap-2">
                Capture
                <kbd className="text-xs font-normal opacity-60">⌘↵</kbd>
              </span>
            )}
          </button>

          {status === "error" && (
            <p className="text-red-400 text-xs text-center pt-1">{error}</p>
          )}
        </div>
      )}

      {/* Result */}
      {status === "done" && result && (
        <div className="w-full stack-3 animate-in fade-in duration-300">

          {/* Title row */}
          <div className="flex items-start justify-between gap-4 pb-1">
            <div className="stack-1.5 min-w-0">
              {result.capture.inferredType && (
                <span className="text-[10px] font-medium uppercase tracking-widest" style={{ color: "var(--gold)" }}>
                  {TYPE_LABELS[result.capture.inferredType] ?? result.capture.inferredType}
                </span>
              )}
              <h2 className="text-base font-semibold leading-snug" style={{ color: "var(--fg)" }}>
                {result.capture.inferredTitle}
              </h2>
            </div>
            <span className="text-[11px] font-medium whitespace-nowrap pt-0.5 shrink-0" style={{ color: "var(--gold)" }}>
              Saved ✓
            </span>
          </div>

          {/* Tags */}
          {result.capture.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {result.capture.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-[11px] px-2.5 py-1 rounded-full font-medium"
                  style={{ background: "var(--gold-faint)", color: "var(--gold)", border: "1px solid var(--gold-low)" }}
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* Core idea */}
          <div className="rounded-2xl p-4" style={CARD_STYLE}>
            <p className="text-[10px] font-medium uppercase tracking-widest mb-2" style={{ color: "var(--gold)" }}>Core idea</p>
            <p className="text-sm leading-relaxed" style={{ color: "var(--fg)" }}>{result.capture.coreIdea}</p>
          </div>

          {/* Takeaways */}
          <div className="rounded-2xl p-4" style={CARD_STYLE}>
            <p className="text-[10px] font-medium uppercase tracking-widest mb-3" style={{ color: "var(--gold)" }}>Takeaways</p>
            <ul className="stack-2.5">
              {result.capture.takeaways.map((t, i) => (
                <li key={i} className="flex gap-2.5 text-sm leading-relaxed">
                  <span className="mt-0.5 shrink-0 select-none" style={{ color: "var(--gold)" }}>–</span>
                  <span style={{ color: "var(--fg-muted)" }}>{t}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Quotes */}
          {result.capture.quotes.length > 0 && (
            <div className="rounded-2xl p-4 stack-3" style={CARD_STYLE}>
              <p className="text-[10px] font-medium uppercase tracking-widest" style={{ color: "var(--gold)" }}>Quote</p>
              {result.capture.quotes.map((q, i) => (
                <blockquote key={i} className="text-sm italic pl-3 leading-relaxed"
                  style={{ color: "var(--fg-muted)", borderLeft: "2px solid var(--gold-quote)" }}>
                  &ldquo;{q}&rdquo;
                </blockquote>
              ))}
            </div>
          )}

          {/* Applied to */}
          {result.capture.appliedTo && (
            <div className="rounded-2xl p-4" style={CARD_STYLE}>
              <p className="text-[10px] font-medium uppercase tracking-widest mb-2" style={{ color: "var(--gold)" }}>Applied to</p>
              <p className="text-sm leading-relaxed" style={{ color: "var(--fg-muted)" }}>{result.capture.appliedTo}</p>
            </div>
          )}

          {/* Filename */}
          <p className="text-[10px] text-center pt-1 font-mono" style={{ color: "var(--fg-muted)" }}>
            {result.filename}
          </p>

          {/* Reset */}
          <button
            onClick={handleReset}
            className="w-full py-3.5 rounded-2xl font-medium text-sm transition-all"
            style={{ background: "transparent", border: "1px solid var(--gold-mid)", color: "var(--fg-muted)" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--gold-high)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--gold-mid)"; }}
          >
            Capture another
          </button>
        </div>
      )}

    </main>
    </>
  );
}
