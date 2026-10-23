import Link from "next/link";
import { KNOWN_ORIGINS, canonicalOrigin } from "@/lib/origin";
import { env } from "@/lib/env";

/** Shown on both documents. Change it whenever either one changes. */
export const LEGAL_EFFECTIVE_DATE = "October 23, 2026";

/**
 * The Privacy Policy and Terms describe the hosted service at xkg.xmu.sh and
 * name its operator. A self-hosted copy has a different operator, so it must
 * not present them as its own. Development builds show them for previewing.
 */
function isHostedInstance(): boolean {
  if (!env.isProduction) return true;
  try {
    return KNOWN_ORIGINS.includes(canonicalOrigin());
  } catch {
    return false;
  }
}

export function LegalTable({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="legal-table">
      <table>
        <thead>
          <tr>{head.map((h) => <th key={h} scope="col">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function LegalPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="min-h-dvh px-4 py-10">
      <article className="legal mx-auto max-w-2xl">
        <p className="legal-meta">
          <Link href="/">xkg</Link>
        </p>
        <h1>{title}</h1>
        {isHostedInstance() ? (
          <>
            <p className="legal-meta">Effective {LEGAL_EFFECTIVE_DATE}</p>
            {children}
          </>
        ) : (
          <p>
            This is a self-hosted copy of xkg. The {title} at{" "}
            <a href="https://xkg.xmu.sh">xkg.xmu.sh</a> covers only the hosted service. Ask whoever
            runs this copy how it handles your data.
          </p>
        )}
        <nav className="legal-nav" aria-label="Legal">
          <Link href="/privacy">Privacy Policy</Link>
          <span aria-hidden="true"> · </span>
          <Link href="/terms">Terms of Service</Link>
        </nav>
      </article>
    </main>
  );
}
