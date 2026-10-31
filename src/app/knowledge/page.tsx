"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import BrandMark from "@/components/BrandMark";
import Backdrop from "@/components/Backdrop";
import type { CaptureRow, CaptureStatus, LinkCheck } from "@/lib/captures";
import type { WeekStats } from "@/lib/ledger";

/**
 * Your knowledge: the decisions about saved knowledge that are the user's to
 * make (archive, delete, rules per tag), notes from the source check, and how much got
 * applied. Everything reads and writes the user's knowledge repo.
 */

const TABS: Array<{ status: CaptureStatus; label: string }> = [
  { status: "inbox", label: "Inbox" },
  { status: "applied", label: "Applied" },
  { status: "archived", label: "Archived" },
];

const CARD_STYLE: React.CSSProperties = {
  background: "var(--card-bg)",
  border: "1px solid var(--gold-faint)",
};

const TRY_AGAIN = "Something went wrong. Try again in a moment.";

/** POSTs JSON; resolves to the parsed body, or throws with the server's error. */
async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (res.status === 401) {
    window.location.assign("/login");
    throw new Error(TRY_AGAIN);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? TRY_AGAIN);
  return data;
}

const OFFLINE = "The original page is offline. What you learned from it is saved in your knowledge repo.";
const UNSURE = "The AI wasn't sure about this one. Worth a quick read.";

/** What the source check found, as notes for the card; empty when the capture looks fine. */
function flagNotes(check: LinkCheck | undefined): string[] {
  switch (check?.status) {
    case "stale": return [OFFLINE];
    case "low_confidence": return [UNSURE];
    case "stale_and_low_confidence": return [OFFLINE, UNSURE];
    default: return [];
  }
}

/** Where an unfinished source check stopped, kept per browser; null when none. */
const CURSOR_KEY = "xkg-source-check-after";
function readCursor(): string | null {
  try { return localStorage.getItem(CURSOR_KEY); } catch { return null; }
}
function writeCursor(after: string | null): void {
  try { after ? localStorage.setItem(CURSOR_KEY, after) : localStorage.removeItem(CURSOR_KEY); } catch { /* private mode: start over next time */ }
}

/** "Oct 26" from 2026-10-26. */
function shortDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export default function KnowledgePage() {
  const [captures, setCaptures] = useState<CaptureRow[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [weeks, setWeeks] = useState<WeekStats[] | null>(null);
  const [tab, setTab] = useState<CaptureStatus>("inbox");
  const [checks, setChecks] = useState<Record<string, LinkCheck>>({});

  useEffect(() => {
    void fetch("/api/captures")
      .then(async (res) => {
        if (res.status === 401) return window.location.assign("/login");
        const data = (await res.json()) as { captures?: CaptureRow[]; error?: string };
        if (!res.ok || !data.captures) throw new Error(data.error ?? TRY_AGAIN);
        setCaptures(data.captures);
      })
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : TRY_AGAIN));
    void fetch("/api/apply-stats")
      .then(async (res) => (res.ok ? setWeeks(((await res.json()) as { weeks: WeekStats[] }).weeks) : undefined))
      .catch(() => { /* the applies line just stays hidden */ });
    // Source check: quietly, page by page, as soon as the page opens. It only
    // adds notes to cards, so any failure (even a 401) means no notes, never
    // an error or a redirect. Pages follow the last checked filename, so a
    // capture archived meanwhile never makes the next page skip one. When the
    // hourly quota runs out mid-way, the place is kept in this browser so the
    // next visit carries on instead of starting over. Leaving the page aborts
    // the request in flight.
    const aborter = new AbortController();
    void (async () => {
      for (let after: string | null = readCursor(); ; ) {
        const res = await fetch("/api/captures/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(after ? { after } : {}), signal: aborter.signal });
        if (res.status === 429) return writeCursor(after);
        if (!res.ok) return;
        const data = (await res.json()) as { results: LinkCheck[]; last: string | null };
        if (aborter.signal.aborted) return;
        setChecks((c) => ({ ...c, ...Object.fromEntries(data.results.map((r) => [r.filename, r])) }));
        if (data.last === null || data.results.length === 0) return writeCursor(null);
        after = data.last;
      }
    })().catch(() => { /* no notes this time */ });
    return () => aborter.abort();
  }, []);

  const shown = useMemo(() => (captures ?? []).filter((c) => c.status === tab), [captures, tab]);
  const counts = useMemo(() => {
    const n: Record<CaptureStatus, number> = { inbox: 0, applied: 0, archived: 0 };
    for (const c of captures ?? []) n[c.status]++;
    return n;
  }, [captures]);
  /** Tags by how many captures carry them, most first. */
  const tags = useMemo(() => {
    const n = new Map<string, number>();
    for (const c of captures ?? []) for (const t of c.tags) n.set(t, (n.get(t) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
  }, [captures]);

  function moved(filename: string, to: CaptureStatus | null) {
    setCaptures((list) => (list ?? []).flatMap((c) => (c.filename !== filename ? [c] : to ? [{ ...c, status: to }] : [])));
  }

  /** Inbox captures with a note, so a screen reader hears that notes arrived. */
  const noted = useMemo(
    () => (captures ?? []).filter((c) => c.status === "inbox" && flagNotes(checks[c.filename]).length > 0).length,
    [captures, checks],
  );

  const thisWeek = weeks?.[0];

  return (
    <>
    <Backdrop strength="quiet" />
    <main className="min-h-dvh flex flex-col px-4 py-8 max-w-xl mx-auto stack-6 wrap-anywhere">
      <div className="w-full">
        <div className="flex items-center gap-3">
          <BrandMark size={40} />
          <h1 className="text-xl font-semibold" style={{ color: "var(--fg)" }}>Your knowledge</h1>
          <Link href="/" className="ml-auto shrink-0 text-sm font-medium" style={{ color: "var(--gold)" }}>Capture</Link>
        </div>
        {thisWeek && (
          <p className="text-[15px] leading-snug mt-3" style={{ color: "var(--fg-muted)" }}>
            {thisWeek.applied} applied this week, {thisWeek.withCommit} with a commit
            {weeks!.length > 1 && <> · {weeks!.slice(1).reduce((n, w) => n + w.applied, 0)} in the {weeks!.length === 2 ? "week" : `${weeks!.length - 1} weeks`} before</>}
          </p>
        )}
      </div>

      {/* Folders */}
      <div role="tablist" aria-label="Folder" className="flex gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.status}
            role="tab"
            aria-selected={tab === t.status}
            onClick={() => setTab(t.status)}
            className="text-sm px-3 py-1.5 rounded-full font-medium"
            style={tab === t.status
              ? { background: "var(--gold-faint)", color: "var(--gold)", border: "1px solid var(--gold-low)" }
              : { color: "var(--fg-muted)", border: "1px solid transparent" }}
          >
            {t.label}{captures ? ` ${counts[t.status]}` : ""}
          </button>
        ))}
      </div>

      {/* List */}
      <p role="status" className="sr-only">{noted > 0 ? `Source check: ${noted} ${noted === 1 ? "capture has" : "captures have"} a note.` : ""}</p>
      {loadError && <p role="alert" className="text-sm" style={{ color: "var(--danger)" }}>{loadError}</p>}
      {!captures && !loadError && <p className="text-sm" style={{ color: "var(--fg-muted)" }}>Loading…</p>}
      {captures && shown.length === 0 && (
        <p className="text-sm" style={{ color: "var(--fg-muted)" }}>
          {tab === "inbox" ? "Nothing in your inbox." : `No ${tab} captures yet.`}
        </p>
      )}
      <ul data-testid="capture-list" className="stack-2.5">
        {shown.map((c) => (
          <CaptureItem key={c.filename} capture={c} notes={tab === "inbox" ? flagNotes(checks[c.filename]) : []} onMoved={moved} />
        ))}
      </ul>

      {tags.length > 0 && <Rules tags={tags} />}
    </main>
    </>
  );
}

function CaptureItem({ capture, notes, onMoved }: {
  capture: CaptureRow;
  notes: string[];
  onMoved: (filename: string, to: CaptureStatus | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");

  async function act(action: "archive" | "delete") {
    setBusy(true);
    setError("");
    try {
      await post("/api/captures/" + action, { filename: capture.filename });
      onMoved(capture.filename, action === "archive" ? "archived" : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : TRY_AGAIN);
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <li className="rounded-2xl p-4 stack-2 min-w-0" style={CARD_STYLE}>
      <p className="text-sm leading-relaxed" style={{ color: "var(--fg)" }}>{capture.summary || capture.slug}</p>
      <p className="text-xs leading-relaxed" style={{ color: "var(--fg-muted)" }}>
        {shortDate(capture.date)}{capture.tags.length > 0 && ` · ${capture.tags.join(", ")}`}
      </p>
      {notes.map((n) => <p key={n} className="text-xs leading-relaxed" style={{ color: "var(--fg-muted)" }}>{n}</p>)}
      {capture.status === "inbox" && (
        confirming ? (
          <div className="flex gap-2 pt-1">
            <button onClick={() => void act("delete")} disabled={busy} aria-busy={busy}
              className="btn-primary flex-1 py-2 rounded-xl font-medium text-sm">Delete for good</button>
            <button onClick={() => setConfirming(false)} disabled={busy}
              className="btn-secondary flex-1 py-2 rounded-xl font-medium text-sm">Keep it</button>
          </div>
        ) : (
          <div className="flex gap-2 pt-1">
            <button onClick={() => void act("archive")} disabled={busy} aria-busy={busy}
              className="btn-secondary flex-1 py-2 rounded-xl font-medium text-sm">Archive</button>
            <button onClick={() => setConfirming(true)} disabled={busy}
              className="btn-secondary flex-1 py-2 rounded-xl font-medium text-sm">Delete</button>
          </div>
        )
      )}
      {error && <p role="alert" className="text-xs leading-relaxed" style={{ color: "var(--danger)" }}>{error}</p>}
    </li>
  );
}

/** Rules for your AI: turns the captures with a tag into rules in RULES.md, which briefings include. */
function Rules({ tags }: { tags: string[] }) {
  const [picked, setTag] = useState(tags[0]!);
  // The picked tag goes away when its last capture is deleted.
  const tag = tags.includes(picked) ? picked : tags[0]!;
  const [busy, setBusy] = useState(false);
  const [rules, setRules] = useState<{ topic: string; rules: string[] } | null>(null);
  const [error, setError] = useState("");

  async function make() {
    setBusy(true);
    setError("");
    setRules(null);
    try {
      setRules(await post<{ topic: string; rules: string[] }>("/api/rules", { tag }));
    } catch (err) {
      setError(err instanceof Error ? err.message : TRY_AGAIN);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl p-4 stack-2.5 min-w-0" style={CARD_STYLE}>
      <p className="eyebrow" style={{ color: "var(--gold)" }}>Rules for your AI</p>
      <p className="text-sm leading-relaxed" style={{ color: "var(--fg-muted)" }}>
        Turn what you saved under a tag into short rules. They go in RULES.md, and your AI gets them at the start of each session.
      </p>
      <select
        aria-label="Tag"
        value={tag}
        onChange={(e) => { setTag(e.target.value); setRules(null); }}
        className="field w-full min-w-0 rounded-xl px-3 py-2.5 text-base focus:outline-hidden"
      >
        {tags.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      <button onClick={() => void make()} disabled={busy} aria-busy={busy}
        className="btn-secondary w-full py-2.5 rounded-xl font-medium text-sm">
        {busy ? "Making rules…" : "Make rules"}
      </button>
      {rules && (rules.rules.length > 0 ? (
        <ol className="stack-2 list-decimal pl-5">
          {rules.rules.map((r, i) => <li key={i} className="text-sm leading-relaxed" style={{ color: "var(--fg)" }}>{r}</li>)}
        </ol>
      ) : (
        <p className="text-sm" style={{ color: "var(--fg-muted)" }}>No captures with that tag to learn from.</p>
      ))}
      {error && <p role="alert" className="text-xs leading-relaxed" style={{ color: "var(--danger)" }}>{error}</p>}
    </section>
  );
}
