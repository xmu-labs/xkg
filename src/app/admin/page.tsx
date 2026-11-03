import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getSession } from "@/lib/session";
import { isOwner } from "@/lib/admin-owner";
import { readStats, statsSummary, weeksOf, type StatsSummary } from "@/lib/admin-stats";
import { CARD_STYLE } from "@/app/knowledge/ui";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Stats · xkg", robots: { index: false, follow: false } };

/**
 * The owner's read of the apply-stats numbers, on a phone: what
 * GET /api/admin/apply-stats returns, added up for the window. Only the login
 * in ADMIN_GITHUB_LOGIN can open it; anyone else gets the app's 404, so the
 * page doesn't say it exists. Counts only: no account, capture or repo.
 * /admin?weeks=12
 */
export default async function AdminPage({ searchParams }: { searchParams: Promise<{ weeks?: string | string[] }> }) {
  if (!isOwner(await getSession())) notFound();
  const asked = (await searchParams).weeks;
  const weeks = weeksOf(Array.isArray(asked) ? asked[0] : asked);

  let summary: StatsSummary | null = null;
  try {
    summary = statsSummary(await readStats(weeks));
  } catch (err) {
    console.error("[admin] stats read failed:", err instanceof Error ? err.message : err);
  }

  return (
    <main className="min-h-dvh flex flex-col px-4 py-8 max-w-xl mx-auto stack-4 wrap-anywhere">
      <div className="stack-1">
        <h1 className="text-xl font-semibold leading-snug" style={{ color: "var(--fg)" }}>Stats</h1>
        <p className="text-sm" style={{ color: "var(--fg-muted)" }}>
          Last {weeks} {weeks === 1 ? "week" : "weeks"}, every account. Counts only.
        </p>
        <nav aria-label="Window" className="flex flex-wrap gap-x-4 text-sm">
          {[1, 4, 12].map((w) => (
            <a key={w} href={`/admin?weeks=${w}`} aria-current={w === weeks ? "page" : undefined}
              className="min-h-11 inline-flex items-center font-medium" style={{ color: w === weeks ? "var(--fg)" : "var(--gold)" }}>
              {w} {w === 1 ? "week" : "weeks"}
            </a>
          ))}
        </nav>
      </div>
      {summary ? <Summary s={summary} /> : (
        <p role="alert" className="text-sm" style={{ color: "var(--danger)" }}>Couldn&apos;t read the stats. Reload in a moment.</p>
      )}
    </main>
  );
}

const ENGINES: Record<string, string> = { jev: "Jev", evidence: "the account's own model" };

function Summary({ s }: { s: StatsSummary }) {
  const agents = Object.entries(s.applies.harnesses).sort((a, b) => b[1] - a[1]);
  return (
    <>
      <Card label="Applies">
        <Row name="Captures applied" value={s.applies.captures} />
        <Row name="With a commit" value={s.applies.withCommit} />
        <Row name="With a reason" value={s.applies.withWhy} />
        {agents.map(([h, n]) => <Row key={h} name={`By ${h}`} value={n} />)}
        <Row name="Accounts active" value={s.accounts} />
      </Card>
      <Card label="Handoffs">
        <Row name="Queued" value={s.handoffs.queued} />
        <Row name="Offered" value={s.handoffs.offered} />
        <Row name="Applied" value={s.handoffs.applied} />
        <Row name="Not a fit" value={s.handoffs.declined} />
        <Row name="Later" value={s.handoffs.later} />
        <Row name="Already done" value={s.handoffs.done} />
        <Row name="No answer" value={s.handoffs.expired} />
        <Row name="Reverted" value={s.handoffs.reverted} />
      </Card>
      <Card label="Where it applies">
        {s.matching.length === 0 && <p className="text-sm" style={{ color: "var(--fg-muted)" }}>No matches in this window.</p>}
        {s.matching.map((m) => (
          <div key={m.scorer} className="stack-2">
            <Row name={`Matches by ${ENGINES[m.scorer] ?? m.scorer}`} value={m.matches} />
            <Row name="Showed a fit (Strong or Possible)" value={m.suggestions} />
          </div>
        ))}
      </Card>
      <Card label="Setup (accounts that signed up in the window)">
        <Row name="Signed up" value={s.setup.signedUp ?? 0} />
        <Row name="Knowledge repo set" value={s.setup.repo ?? 0} />
        <Row name="AI key added" value={s.setup.aiKey ?? 0} />
        <Row name="First capture" value={s.setup.capture ?? 0} />
        <Row name="First agent call" value={s.setup.agent ?? 0} />
        <Row name="Agent shown a capture" value={s.setup.shown ?? 0} />
        <Row name="First apply" value={s.setup.apply ?? 0} />
      </Card>
    </>
  );
}

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl p-4 stack-2 min-w-0" style={CARD_STYLE}>
      <h2 className="eyebrow" style={{ color: "var(--gold)" }}>{label}</h2>
      {children}
    </section>
  );
}

function Row({ name, value }: { name: string; value: number }) {
  return (
    <p className="flex items-baseline justify-between gap-3 text-sm">
      <span className="min-w-0" style={{ color: "var(--fg-muted)" }}>{name}</span>
      <span className="shrink-0 whitespace-nowrap font-semibold tabular-nums" style={{ color: "var(--fg)" }}>{value}</span>
    </p>
  );
}
