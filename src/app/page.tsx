"use client";

import { useState, useEffect, useRef } from "react";
import SettingsDrawer, { type Me } from "@/components/SettingsDrawer";
import BrandMark from "@/components/BrandMark";
import Backdrop from "@/components/Backdrop";

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
  /** The capture on GitHub; older servers don't send it. */
  fileUrl?: string;
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

/** A field inside the composer: borderless, the composer card draws the edge. */
const CAPTURE_FAILED = "Couldn't capture that. Try again in a moment.";

const COMPOSER_FIELD = "w-full bg-transparent px-4 py-3 text-base focus:outline-hidden";

/** Known types get their label; a type the model invented reads as words. */
function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());
}

const CARD_STYLE: React.CSSProperties = {
  background: "var(--card-bg)",
  border: "1px solid var(--gold-faint)",
};

/** Stagger slot for a result card's entrance (see [data-reveal] in globals.css). */
const reveal = (i: number) => ({ "--i": i }) as React.CSSProperties;

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
        let errorMsg = CAPTURE_FAILED;
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
      setError(err instanceof Error ? err.message : CAPTURE_FAILED);
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
    <Backdrop strength="quiet" />
    {newVersionAvailable && (
      <div className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
        style={{ background: "var(--bg)", borderBottom: "1px solid var(--gold-faint)" }}>
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
          <BrandMark size={56} />
          <h1 className="wordmark text-2xl" style={{ color: "var(--fg)" }}>xkg</h1>
          <SettingsDrawer me={me} onMe={setMe} newVersionAvailable={newVersionAvailable} />
        </div>
        <p className="text-[15px] leading-snug mt-3" style={{ color: "var(--fg-muted)" }}>
          Learn it once. Your AI applies it.
        </p>
      </div>

      {/* Capture form */}
      {status !== "done" && (
        <div className="w-full stack-2.5">
          <div data-composer className="composer rounded-2xl overflow-hidden">
          <input
            type="text"
            aria-label="Title"
            placeholder="Title (optional)"
            enterKeyHint="next"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className={COMPOSER_FIELD + " font-medium"}
          />
          <div className="h-px mx-4" style={{ background: "var(--gold-faint)" }} aria-hidden="true" />

          <textarea
            aria-label="Content to capture"
            placeholder="Paste a link, an article or your notes…"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={9}
            className={COMPOSER_FIELD + " resize-none leading-relaxed"}
          />
          </div>
          <p className="text-xs leading-relaxed px-1" style={{ color: "var(--fg-muted)" }}>
            Paste a link or a note. xkg saves the core idea and where to use it to your GitHub, and your AI tools read it from there.
          </p>

          <div className="capture-bar">
          <button
            onClick={() => void handleSubmit()}
            disabled={!content.trim() || status === "loading"}
            aria-busy={status === "loading"}
            className="btn-primary w-full py-3.5 rounded-2xl font-semibold text-[15px] disabled:cursor-not-allowed"
          >
            {status === "loading" ? (
              <span data-label="loading" key="loading" className="flex items-center justify-center gap-2">
                <span className="inline-block w-3.5 h-3.5 border-2 rounded-full animate-spin"
                  style={{ borderColor: "var(--spinner-track)", borderTopColor: "var(--fg)" }} />
                Extracting insights…
              </span>
            ) : (
              <span data-label="idle" key="idle">Capture</span>
            )}
          </button>
          </div>

          {status === "error" && (
            <p role="alert" className="text-xs text-center pt-1" style={{ color: "var(--danger)" }}>{error}</p>
          )}
        </div>
      )}

      {/* Result */}
      {status === "done" && result && (
        <div className="w-full min-w-0 stack-3 wrap-anywhere">

          {/* Title row */}
          <div data-reveal style={reveal(0)} className="flex items-start justify-between gap-4 pb-1">
            <div className="stack-1.5 min-w-0">
              {result.capture.inferredType && (
                <span className="eyebrow" style={{ color: "var(--gold)" }}>
                  {typeLabel(result.capture.inferredType)}
                </span>
              )}
              <h2 className="text-lg font-semibold leading-snug" style={{ color: "var(--fg)" }}>
                {result.capture.inferredTitle}
              </h2>
            </div>
            <span className="saved-pop text-[11px] font-medium whitespace-nowrap pt-0.5 shrink-0" style={{ color: "var(--gold)" }}>
              Saved to GitHub ✓
            </span>
          </div>

          {/* Tags */}
          {result.capture.tags.length > 0 && (
            <div data-reveal style={reveal(1)} className="flex flex-wrap gap-1.5">
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
          <div data-reveal className="rounded-2xl p-4" style={{ ...CARD_STYLE, ...reveal(2) }}>
            <p className="eyebrow mb-2" style={{ color: "var(--gold)" }}>Core idea</p>
            <p className="text-sm leading-relaxed" style={{ color: "var(--fg)" }}>{result.capture.coreIdea}</p>
          </div>

          {/* Takeaways */}
          <div data-reveal className="rounded-2xl p-4" style={{ ...CARD_STYLE, ...reveal(3) }}>
            <p className="eyebrow mb-3" style={{ color: "var(--gold)" }}>Takeaways</p>
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
            <div data-reveal className="rounded-2xl p-4 stack-3" style={{ ...CARD_STYLE, ...reveal(4) }}>
              <p className="eyebrow" style={{ color: "var(--gold)" }}>Quote</p>
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
            <div data-reveal className="rounded-2xl p-4" style={{ ...CARD_STYLE, ...reveal(5) }}>
              <p className="eyebrow mb-2" style={{ color: "var(--gold)" }}>Where to use it</p>
              <p className="text-sm leading-relaxed" style={{ color: "var(--fg-muted)" }}>{result.capture.appliedTo}</p>
            </div>
          )}

          {/* Filename */}
          <p className="text-[10px] text-center pt-1 font-mono" style={{ color: "var(--fg-muted)" }}>
            {result.fileUrl ? (
              <a href={result.fileUrl} target="_blank" rel="noopener noreferrer"
                className="underline underline-offset-2">{result.filename}</a>
            ) : result.filename}
          </p>

          {/* Next step */}
          <p className="text-sm text-center leading-relaxed" style={{ color: "var(--fg-muted)" }}>
            Try it: ask your AI <em style={{ color: "var(--fg)" }}>&ldquo;brief me on what I saved today&rdquo;</em>
          </p>

          {/* Reset */}
          <button
            onClick={handleReset}
            className="btn-secondary w-full py-3.5 rounded-2xl font-medium text-sm"
          >
            Capture another
          </button>
        </div>
      )}

    </main>
    </>
  );
}
