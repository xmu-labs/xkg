"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import BrandMark from "@/components/BrandMark";
import Link from "next/link";
import SettingsDrawer, { type Me } from "@/components/SettingsDrawer";
import Backdrop from "@/components/Backdrop";
import type { CaptureRow, CaptureStatus, LinkCheck } from "@/lib/captures";
import type { WeekStats } from "@/lib/ledger";
import { CARD_STYLE, TRY_AGAIN, captureHref, post, shortDate } from "./ui";
import { SPEND_CHANGED_EVENT } from "@/lib/spend-format";
import type { BackfillEstimate, BackfillPage } from "@/lib/use-it-when-backfill";

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

export default function KnowledgePage() {
  const [me, setMe] = useState<Me | null>(null);
  const [captures, setCaptures] = useState<CaptureRow[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [weeks, setWeeks] = useState<WeekStats[] | null>(null);
  const [tab, setTab] = useState<CaptureStatus>("inbox");
  const [checks, setChecks] = useState<Record<string, LinkCheck>>({});

  // The tab lives in the address, so Back from a capture lands on the same one.
  // It is read once the list arrives, in the same update, so the chosen tab
  // and its captures appear together.
  function tabFromAddress(): CaptureStatus | null {
    const t = new URLSearchParams(window.location.search).get("tab");
    return TABS.some((x) => x.status === t) ? (t as CaptureStatus) : null;
  }

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
        const fromAddress = tabFromAddress();
        if (fromAddress) setTab(fromAddress);
        setCaptures(data.captures);
      })
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : TRY_AGAIN));
    void fetch("/api/me")
      .then(async (res) => (res.ok ? setMe((await res.json()) as Me) : undefined))
      .catch(() => { /* the menu shows no name */ });
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
          <div className="ml-auto shrink-0">
            <SettingsDrawer me={me} onMe={setMe} newVersionAvailable={false} />
          </div>
        </div>
        {thisWeek && (
          <p className="text-[15px] leading-snug mt-3" style={{ color: "var(--fg-muted)" }}>
            {thisWeek.applied} applied this week, {thisWeek.withCommit} with a commit
            {weeks!.length > 1 && <> · {weeks!.slice(1).reduce((n, w) => n + w.applied, 0)} in the {weeks!.length === 2 ? "week" : `${weeks!.length - 1} weeks`} before</>}
          </p>
        )}
      </div>

      <UseItWhenBackfill />

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

/** Kept per browser and per account and repo (`scope`) once a full pass ended with nothing to retry. */
const BACKFILL_DONE_KEY = "xkg-use-it-when-done";
/** Where a paused backfill stopped, per account and repo, so the next run carries on. */
/** Why captures failed, most first, in plain words: "120 GitHub refused the save (HTTP 409), 3 moved". */
function failureReasons(reasons: Record<string, number>): string {
  const say = (key: string): string => {
    if (key === "moved") return "moved or deleted during the run";
    if (key === "model-error") return "your AI model didn't answer";
    if (key === "model-rules") return "the model's line broke the rules";
    if (key === "model-empty") return "the model gave an empty answer";
    if (key === "model-not-json") return "the model didn't answer in the asked format";
    if (key === "model-no-line") return "the model's answer had no line in it";
    if (key === "model-wrong-start") return "the model's line didn't start with \u201cUse it when\u201d";
    if (key === "model-too-long") return "the model's line was over 25 words";
    if (key === "no-frontmatter") return "the file has no header for the line";
    const http = /^github-(\w+)$/.exec(key)?.[1];
    return http ? `GitHub refused the save (HTTP ${http})` : key;
  };
  return Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${say(k)}`).join(", ");
}

const BACKFILL_AFTER_KEY = "xkg-use-it-when-after";
/** Failures earlier in a paused pass: they sit behind the saved place, so a pass with any isn't done. */
const BACKFILL_FAILED_KEY = "xkg-use-it-when-failed";
/** Why the captures behind the saved place failed, so a pause or a reload doesn't lose it. */
const BACKFILL_REASONS_KEY = "xkg-use-it-when-reasons";
function storedReasons(key: string): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(stored(key) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, n]) => typeof n === "number" && n > 0)) as Record<string, number>;
  } catch { return {}; }
}
function store(key: string, value: string | null): void {
  try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* private mode */ }
}
function stored(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

/**
 * Offers to give older captures their "Use it when" line, on the user's own
 * model, with what it should cost shown before anything runs. It runs page
 * by page only while this page is open, and picks up where it stopped. A
 * pass, even one split by the hourly limit, hides the card only when no page
 * of it had a failure: a capture that failed sits behind the saved place, so
 * the card comes back for a full pass, which skips finished captures for free.
 */
function UseItWhenBackfill() {
  const [estimate, setEstimate] = useState<(BackfillEstimate & { scope: string }) | null>(null);
  const [state, setState] = useState<"idle" | "running" | "done" | "paused" | "error">("idle");
  const [counts, setCounts] = useState({ seen: 0, written: 0, none: 0, failed: 0, skipped: 0 });
  const [reasons, setReasons] = useState<Record<string, number>>({});
  /** Failures from earlier in a pass that paused: they still need a retry. */
  const [failedEarlier, setFailedEarlier] = useState(0);
  const [pausedBecause, setPausedBecause] = useState<string | null>(null);
  const [error, setError] = useState("");
  const aborter = useRef<AbortController | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    aborter.current = ac;
    // Quiet like the source check: any failure (even a 401) means no card, never a redirect.
    void fetch("/api/captures/use-it-when", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ estimate: true }), signal: ac.signal })
      .then(async (res) => {
        if (!res.ok) return;
        const e = (await res.json()) as BackfillEstimate & { scope: string };
        if (e.captures > 0 && !stored(`${BACKFILL_DONE_KEY}:${e.scope}`)) setEstimate(e);
      })
      .catch(() => { /* no card this time */ });
    // Leaving the page stops the run: no page is asked for after this.
    return () => ac.abort();
  }, []);

  async function run(scope: string) {
    const signal = aborter.current?.signal;
    const afterKey = `${BACKFILL_AFTER_KEY}:${scope}`;
    const failedKey = `${BACKFILL_FAILED_KEY}:${scope}`;
    const reasonsKey = `${BACKFILL_REASONS_KEY}:${scope}`;
    setState("running");
    setError("");
    const total = { seen: 0, written: 0, none: 0, failed: 0, skipped: 0 };
    const resumed = stored(afterKey);
    const failedBefore = resumed ? Number(stored(failedKey)) || 0 : 0;
    const why: Record<string, number> = resumed ? storedReasons(reasonsKey) : {};
    // Counts are this run's; what failed before the pause comes back as failedEarlier.
    setCounts({ ...total });
    setFailedEarlier(failedBefore);
    setReasons({ ...why });
    const keepPlace = (after: string | null) => {
      store(afterKey, after);
      store(failedKey, String(failedBefore + total.failed));
      store(reasonsKey, JSON.stringify(why));
    };
    try {
      for (let after = resumed; ; ) {
        if (signal?.aborted) return;
        const res = await fetch("/api/captures/use-it-when", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(after ? { after } : {}), signal });
        if (res.status === 429) {
          // The hourly page limit, or GitHub limiting writes; only the second needs its own words.
          const said = ((await res.json().catch(() => ({}))) as { error?: string }).error;
          keepPlace(after);
          setPausedBecause(said?.startsWith("GitHub") ? said : null);
          return setState("paused");
        }
        const page = (await res.json().catch(() => ({}))) as BackfillPage & { error?: string };
        if (!res.ok) throw new Error(page.error ?? TRY_AGAIN);
        total.written += page.written; total.none += page.none; total.failed += page.failed; total.skipped += page.skipped;
        total.seen += page.written + page.none + page.failed + page.skipped;
        setCounts({ ...total });
        for (const [k, n] of Object.entries(page.reasons ?? {})) why[k] = (why[k] ?? 0) + n;
        setReasons({ ...why });
        window.dispatchEvent(new Event(SPEND_CHANGED_EVENT));
        if (!page.next) break;
        after = page.next;
        keepPlace(after);
      }
      store(afterKey, null);
      store(failedKey, null);
      store(reasonsKey, null);
      if (failedBefore + total.failed === 0) store(`${BACKFILL_DONE_KEY}:${scope}`, "1");
      setState("done");
    } catch (err) {
      if (signal?.aborted) return;
      setError(err instanceof Error ? err.message : TRY_AGAIN);
      setState("error");
    }
  }

  if (!estimate) return null;
  const failed = failedEarlier + counts.failed;
  const why = Object.keys(reasons).length > 0 ? failureReasons(reasons) : null;
  const price = estimate.usd === null ? null : estimate.usd < 0.01 ? "Under $0.01" : `About $${estimate.usd.toFixed(2)}`;
  const cost = price === null
    ? "Your model has no price on file, so there's no estimate."
    : `${price} on your AI key.${estimate.reasoning ? " Your model thinks before it answers, so it may cost more." : ""}`;
  return (
    <section aria-label="Use it when lines" className="rounded-2xl p-4 stack-2" style={CARD_STYLE}>
      {state === "done" ? (
        <p role="status" className="text-sm leading-relaxed" style={{ color: "var(--fg)" }}>
          Done. {counts.written} {counts.written === 1 ? "line" : "lines"} added
          {counts.none > 0 && <>, {counts.none} with nothing reusable</>}
          {failed > 0 && <>, {failed} to try again later</>}.
          {failed > 0 && why && <> Why: {why}.</>}
        </p>
      ) : (
        <>
          <p className="text-sm leading-relaxed" style={{ color: "var(--fg)" }}>
            Give your older captures a &ldquo;Use it when&rdquo; line, so xkg can bring them back when something comes up.
          </p>
          <p className="text-xs leading-relaxed" style={{ color: "var(--fg-muted)" }}>
            Checks your {estimate.captures} captures and skips any that already have a line. {cost}
          </p>
          {state === "running" && <p role="status" className="text-xs" style={{ color: "var(--fg-muted)" }}>Adding lines: {counts.seen} of {estimate.captures}…</p>}
          {state === "paused" && <p role="status" className="text-xs" style={{ color: "var(--fg-muted)" }}>{pausedBecause ?? "Paused at the hourly limit. Start again later and it picks up where it stopped."}{failed > 0 && why && <> Why {failed} failed so far: {why}.</>}</p>}
          {error && <p role="alert" className="text-xs" style={{ color: "var(--danger)" }}>{error}</p>}
          <button onClick={() => void run(estimate.scope)} disabled={state === "running"} aria-busy={state === "running"}
            className="btn-primary py-2 rounded-xl font-medium text-sm">
            {state === "running" ? "Adding lines…" : state === "idle" ? "Add lines" : "Continue"}
          </button>
        </>
      )}
    </section>
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
      <Link href={captureHref(capture.filename)} className="block stack-2 -m-1 p-1 rounded-xl">
        <span className="block text-sm leading-relaxed" style={{ color: "var(--fg)" }}>{capture.summary || capture.slug}</span>
        <span className="block text-xs leading-relaxed" style={{ color: "var(--fg-muted)" }}>
          {shortDate(capture.date)}{capture.tags.length > 0 && ` · ${capture.tags.join(", ")}`}
        </span>
      </Link>
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
