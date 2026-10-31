"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import ApplyIt, { applyWhere, explainFiles } from "@/components/ApplyIt";
import Backdrop from "@/components/Backdrop";
import SettingsDrawer, { type Me } from "@/components/SettingsDrawer";
import type { CaptureDetail } from "@/lib/capture-detail";
import { CARD_STYLE, TRY_AGAIN, captureHref, post, shortDate } from "../ui";

/**
 * One capture, read again: everything its file holds except the raw capture
 * and source text, which "Open in GitHub" covers. Read-only apart from
 * Archive and Delete for inbox captures.
 */

const TYPE_LABELS: Record<string, string> = {
  article: "Article", blog: "Blog", research: "Research", transcript: "Transcript",
  notes: "Notes", post: "Post", book: "Book", url: "Link",
};
const STATUS_LABELS: Record<CaptureDetail["status"], string> = { inbox: "Inbox", applied: "Applied", archived: "Archived" };

function domain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function Card({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return (
    <section data-testid={testId} className="rounded-2xl p-4 stack-2.5 min-w-0" style={CARD_STYLE}>
      <h2 className="eyebrow" style={{ color: "var(--gold)" }}>{label}</h2>
      {children}
    </section>
  );
}

export default function CapturePage() {
  const params = useParams<{ name: string }>();
  let name = params.name ?? "";
  try { name = decodeURIComponent(name); } catch { /* already decoded */ }
  // Keyed by name, so following a link to another capture starts fresh.
  return <CaptureLoader key={name} filename={`${name}.md`} />;
}

function CaptureLoader({ filename }: { filename: string }) {
  const [capture, setCapture] = useState<CaptureDetail | null>(null);
  const [error, setError] = useState("");
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    void fetch("/api/me")
      .then(async (res) => (res.ok ? setMe((await res.json()) as Me) : undefined))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void fetch(`/api/captures/read?name=${encodeURIComponent(filename)}`)
      .then(async (res) => {
        if (res.status === 401) return window.location.assign("/login");
        const data = (await res.json().catch(() => ({}))) as { capture?: CaptureDetail; error?: string };
        if (!res.ok || !data.capture) throw new Error(res.status === 400 ? "This capture can't be opened." : data.error ?? TRY_AGAIN);
        setCapture(data.capture);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : TRY_AGAIN));
  }, [filename]);

  const back = `/knowledge${capture && capture.status !== "inbox" ? `?tab=${capture.status}` : ""}`;

  return (
    <>
    <Backdrop strength="quiet" />
    <main className="min-h-dvh flex flex-col px-4 py-8 max-w-xl mx-auto stack-4 wrap-anywhere">
      <div className="flex items-center gap-3">
        <Link href={back} className="min-h-11 -my-2 flex items-center text-sm font-medium" style={{ color: "var(--gold)" }}>
          ← Your knowledge
        </Link>
        <div className="ml-auto shrink-0">
          <SettingsDrawer me={me} onMe={setMe} newVersionAvailable={false} />
        </div>
      </div>

      {error && <p role="alert" className="text-sm" style={{ color: "var(--danger)" }}>{error}</p>}
      {!capture && !error && <p className="text-sm" style={{ color: "var(--fg-muted)" }}>Loading…</p>}
      {capture && <CaptureView capture={capture} onCapture={setCapture} />}
    </main>
    </>
  );
}

function CaptureView({ capture: c, onCapture }: { capture: CaptureDetail; onCapture: (c: CaptureDetail) => void }) {
  const meta = [c.date && shortDate(c.date), c.type && (TYPE_LABELS[c.type] ?? c.type), STATUS_LABELS[c.status]].filter(Boolean).join(" · ");
  return (
    <div className="w-full min-w-0 stack-3">
      <div className="stack-1.5">
        <h1 className="text-xl font-semibold leading-snug" style={{ color: "var(--fg)" }}>{c.title}</h1>
        <p className="text-sm" style={{ color: "var(--fg-muted)" }}>{meta}</p>
        {c.url && (
          <a href={c.url} target="_blank" rel="noopener noreferrer" className="inline-block text-sm font-medium py-1" style={{ color: "var(--gold)" }}>
            Read the source on {domain(c.url)} ↗
          </a>
        )}
      </div>

      {c.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {c.tags.map((tag) => (
            <span key={tag} className="text-[11px] px-2.5 py-1 rounded-full font-medium"
              style={{ background: "var(--gold-faint)", color: "var(--gold)", border: "1px solid var(--gold-low)" }}>
              {tag}
            </span>
          ))}
        </div>
      )}

      {c.lowConfidence && (
        <p role="note" className="text-sm leading-relaxed" style={{ color: "var(--danger)" }}>
          The extraction was unsure. Check the source before you act on it.
        </p>
      )}

      {c.coreIdea && (
        <Card label="Core idea">
          <p className="text-sm leading-relaxed" style={{ color: "var(--fg)" }}>{c.coreIdea}</p>
        </Card>
      )}

      <ApplyIt
        where={applyWhere(c.where)}
        advice={c.advice}
        explain={c.where?.repo ? {
          auto: c.where.fit === "Strong fit",
          onRequest: async () => {
            if (!c.where) return;
            const files = await explainFiles(c.filename, c.where.files);
            onCapture({ ...c, where: { ...c.where, files } });
          },
        } : undefined}
      />

      {c.takeaways.length > 0 && (
        <Card label="Takeaways">
          <ul className="stack-2.5">
            {c.takeaways.map((t, i) => (
              <li key={i} className="flex gap-2.5 text-sm leading-relaxed">
                <span className="mt-0.5 shrink-0 select-none" style={{ color: "var(--gold)" }}>–</span>
                <span style={{ color: "var(--fg-muted)" }}>{t}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {c.quotes.length > 0 && (
        <Card label={c.quotes.length > 1 ? "Quotes" : "Quote"}>
          {c.quotes.map((q, i) => (
            <blockquote key={i} className="text-sm italic pl-3 leading-relaxed"
              style={{ color: "var(--fg-muted)", borderLeft: "2px solid var(--gold-quote)" }}>
              &ldquo;{q}&rdquo;
            </blockquote>
          ))}
        </Card>
      )}


      {c.applications.length > 0 && (
        <Card label={c.applications.length > 1 ? `Applied ${c.applications.length} times` : "Applied"} testId="applied">
          <ul className="stack-2">
            {c.applications.map((a, i) => (
              <li key={i} className="text-sm leading-relaxed" style={{ color: "var(--fg-muted)" }}>
                <span style={{ color: "var(--fg)" }}>{shortDate(a.date)}</span>
                {a.commit && <> · commit <code className="font-mono text-[12px]">{a.commit.slice(0, 7)}</code></>}
                {a.target && <> · <code className="font-mono text-[12px]">{a.target}</code></>}
                {a.outcome && <> · {a.outcome}</>}
                {a.note && <span className="block">{a.note}</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {c.links.length > 0 && (
        <Card label="Links to memory" testId="links">
          <ul className="stack-1">
            {c.links.map((l) => (
              <li key={l.name}>
                <Link href={captureHref(l.name)} className="block rounded-xl py-2 min-h-11">
                  <span className="block text-sm font-medium leading-snug" style={{ color: "var(--fg)" }}>{l.summary || l.slug.replace(/-/g, " ")}</span>
                  {l.note && <span className="block text-xs leading-relaxed mt-0.5" style={{ color: "var(--fg-muted)" }}>{l.note}</span>}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {c.evidence.length > 0 && (
        <details className="rounded-2xl p-4 min-w-0" style={CARD_STYLE}>
          <summary className="eyebrow cursor-pointer min-h-6" style={{ color: "var(--gold)" }}>Show evidence</summary>
          <div className="stack-3 pt-3">
            {c.evidence.map((e) => (
              <div key={e.label} className="stack-1.5">
                <p className="text-xs font-medium" style={{ color: "var(--fg)" }}>{e.label}</p>
                {e.quotes.map((q, i) => (
                  <blockquote key={i} className="text-sm pl-3 leading-relaxed"
                    style={{ color: "var(--fg-muted)", borderLeft: "2px solid var(--gold-quote)" }}>
                    {q}
                  </blockquote>
                ))}
              </div>
            ))}
          </div>
        </details>
      )}

      <p className="text-xs text-center pt-1">
        <a href={c.fileUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2" style={{ color: "var(--fg-muted)" }}>
          Open in GitHub
        </a>
      </p>

      {c.status === "inbox" && <Actions filename={c.filename} />}
    </div>
  );
}

function Actions({ filename }: { filename: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");

  async function act(action: "archive" | "delete") {
    setBusy(true);
    setError("");
    try {
      await post("/api/captures/" + action, { filename });
      router.push("/knowledge");
    } catch (err) {
      setError(err instanceof Error ? err.message : TRY_AGAIN);
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div className="stack-2">
      {confirming ? (
        <div className="flex gap-2">
          <button onClick={() => void act("delete")} disabled={busy} aria-busy={busy}
            className="btn-primary flex-1 py-2.5 rounded-xl font-medium text-sm">Delete for good</button>
          <button onClick={() => setConfirming(false)} disabled={busy}
            className="btn-secondary flex-1 py-2.5 rounded-xl font-medium text-sm">Keep it</button>
        </div>
      ) : (
        <div className="flex gap-2">
          <button onClick={() => void act("archive")} disabled={busy} aria-busy={busy}
            className="btn-secondary flex-1 py-2.5 rounded-xl font-medium text-sm">Archive</button>
          <button onClick={() => setConfirming(true)} disabled={busy}
            className="btn-secondary flex-1 py-2.5 rounded-xl font-medium text-sm">Delete</button>
        </div>
      )}
      {error && <p role="alert" className="text-xs leading-relaxed" style={{ color: "var(--danger)" }}>{error}</p>}
    </div>
  );
}
