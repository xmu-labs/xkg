/** What the Your knowledge list and the capture page share. */

export const CARD_STYLE: React.CSSProperties = {
  background: "var(--card-bg)",
  border: "1px solid var(--gold-faint)",
};

export const TRY_AGAIN = "Something went wrong. Try again in a moment.";

/** POSTs JSON; resolves to the parsed body, or throws with the server's error. */
export async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (res.status === 401) {
    window.location.assign("/login");
    throw new Error(TRY_AGAIN);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? TRY_AGAIN);
  return data;
}

/** "Oct 26" from 2026-10-26. */
export function shortDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** The capture page's address for a capture file: the name without ".md". */
export function captureHref(filename: string): string {
  return `/knowledge/${encodeURIComponent(filename.replace(/\.md$/, ""))}`;
}
