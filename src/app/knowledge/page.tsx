"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import BrandMark from "@/components/BrandMark";
import Backdrop from "@/components/Backdrop";
import type { CaptureRow, CaptureStatus, LinkCheck } from "@/lib/captures";
import type { WeekStats } from "@/lib/ledger";
import { CARD_STYLE, TRY_AGAIN, captureHref, post, shortDate } from "./ui";

/**
 * Your knowledge: the decisions about saved knowledge that are the user's to
 * make (archive, delete, check links, rules per tag) and how much of it got
 * applied. Everything reads and writes the user's knowledge repo.
 */

const TABS: Array<{ status: CaptureStatus; label: string }> = [
  { status: "inbox", label: "Inbox" },
  { status: "applied", label: "Applied" },
  { status: "archived", label: "Archived" },
];

/** What a link check found, in words; null when the capture looks fine. */
function flagText(check: LinkCheck | undefined): string | null {
  switch (check?.status) {
    case "stale": return "Source is gone";
    case "low_confidence": return "Low confidence";
    case "stale_and_low_confidence": return "Source is gone · Low confidence";
    default: return null;
  }
}

export default function KnowledgePage() {
  const [captures, setCaptures] = useState<CaptureRow[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [weeks, setWeeks] = useState<WeekStats[] | null>(null);
  const [tab, setTab] = useState<CaptureStatus>("inbox");
  const [checks, setChecks] = useState<Record<string, LinkCheck>>({});
  const [checkState, setCheckState] = useState<{ busy: boolean; checked: number; total: number; next: number | null; error: string }>({ busy: false, checked: 0, total: 0, next: 0, error: "" });

  // The tab lives in the address, so Back from a capture lands on the same one.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (TABS.some((x) => x.status === t)) setTab(t as CaptureStatus);
  }, []);

  function pickTab(t: CaptureStatus) {
    setTab(t);
    window.history.replaceState(window.history.state, "", t === "inbox" ? "/knowledge" : `/knowledge?tab=${t}`);
  }

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
    // It left the inbox, so the next link check's offset counts one file fewer
    // when this one was already checked; otherwise a file would be skipped.
    const wasChecked = filename in checks;
    setChecks(({ [filename]: _, ...rest }) => rest);
    setCheckState((s) => ({
      ...s,
      total: Math.max(s.total - 1, 0),
      checked: wasChecked ? s.checked - 1 : s.checked,
      next: wasChecked && s.next !== null ? s.next - 1 : s.next,
    }));
  }

  async function checkLinks() {
    const offset = checkState.next ?? 0;
    setCheckState((s) => ({ ...s, busy: true, error: "" }));
    try {
      const data = await post<{ results: LinkCheck[]; total: number; next: number | null }>("/api/captures/check", { offset });
      setChecks((c) => ({ ...c, ...Object.fromEntries(data.results.map((r) => [r.filename, r])) }));
      setCheckState((s) => ({ busy: false, checked: offset + data.results.length, total: data.total, next: data.next, error: "" }));
    } catch (err) {
      setCheckState((s) => ({ ...s, busy: false, error: err instanceof Error ? err.message : TRY_AGAIN }));
    }
  }

  const flagged = Object.values(checks).filter((c) => flagText(c) && captures?.some((r) => r.filename === c.filename && r.status === "inbox")).length;
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
            onClick={() => pickTab(t.status)}
            className="text-sm px-3 py-1.5 rounded-full font-medium"
            style={tab === t.status
              ? { background: "var(--gold-faint)", color: "var(--gold)", border: "1px solid var(--gold-low)" }
              : { color: "var(--fg-muted)", border: "1px solid transparent" }}
          >
            {t.label}{captures ? ` ${counts[t.status]}` : ""}
          </button>
        ))}
      </div>

      {tab === "inbox" && counts.inbox > 0 && (
        <div className="stack-1.5">
          <button
            onClick={() => void checkLinks()}
            disabled={checkState.busy || (checkState.checked > 0 && checkState.next === null)}
            aria-busy={checkState.busy}
            className="btn-secondary w-full py-2.5 rounded-xl font-medium text-sm disabled:cursor-not-allowed"
          >
            {checkState.checked > 0 && checkState.next !== null ? "Check more links" : "Check links"}
          </button>
          {checkState.checked > 0 && (
            <p className="text-xs leading-relaxed" style={{ color: "var(--fg-muted)" }}>
              {flagged} of {checkState.checked} need a look.
              {checkState.next !== null && ` ${checkState.total - checkState.checked} not checked yet.`}
            </p>
          )}
          {checkState.error && <p role="alert" className="text-xs" style={{ color: "var(--danger)" }}>{checkState.error}</p>}
        </div>
      )}

      {/* List */}
      {loadError && <p role="alert" className="text-sm" style={{ color: "var(--danger)" }}>{loadError}</p>}
      {!captures && !loadError && <p className="text-sm" style={{ color: "var(--fg-muted)" }}>Loading…</p>}
      {captures && shown.length === 0 && (
        <p className="text-sm" style={{ color: "var(--fg-muted)" }}>
          {tab === "inbox" ? "Nothing in your inbox." : `No ${tab} captures yet.`}
        </p>
      )}
      <ul data-testid="capture-list" className="stack-2.5">
        {shown.map((c) => (
          <CaptureItem key={c.filename} capture={c} flag={tab === "inbox" ? flagText(checks[c.filename]) : null} onMoved={moved} />
        ))}
      </ul>

      {tags.length > 0 && <Rules tags={tags} />}
    </main>
    </>
  );
}

function CaptureItem({ capture, flag, onMoved }: {
  capture: CaptureRow;
  flag: string | null;
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
      <Link href={captureHref(capture.filename)} className="block stack-2 -m-1 p-1 rounded-xl">
        <span className="block text-sm leading-relaxed" style={{ color: "var(--fg)" }}>{capture.summary || capture.slug}</span>
        <span className="block text-xs leading-relaxed" style={{ color: "var(--fg-muted)" }}>
          {shortDate(capture.date)}{capture.tags.length > 0 && ` · ${capture.tags.join(", ")}`}
        </span>
      </Link>
      {flag && <p className="text-xs font-medium" style={{ color: "var(--danger)" }}>{flag}</p>}
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
