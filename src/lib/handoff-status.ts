/**
 * What the capture card says about a capture's handoff in one repo, from its
 * HANDOFFS.md row (status and since). Pure, so the card and its tests share it.
 *
 *   no row ──────────────> Hand off button
 *   pending / snoozed ───> "Sent …" / "You said later …"
 *   expired ─────────────> "Offered 3 times …" + Hand off again
 *   declined / applied / done / dead ──> what happened, nothing more to do
 *
 * The page never asks the user to decline: judging fit is xkg's job, and a no
 * comes from the user's answer to their coding agent's offer (XKG-187).
 */

/** One HANDOFFS.md row, as the capture page gets it. */
export interface HandoffState {
  repo: string;
  status: string;
  since: string;
  /** A decline HANDOFFS.md has but the capture's Handoff log doesn't yet. Read like any decline. */
  unfinished?: boolean;
}

export interface HandoffStatus {
  /** A short label for the chip; null with no row. */
  chip: string | null;
  text: string | null;
  canHandOff: boolean;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Nov 2" for 2026-11-02, or null when it isn't a date. */
export function shortDate(date: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${month} ${Number(m[3])}` : null;
}

const FINISHED: Record<string, (repo: string) => { chip: string; text: string }> = {
  declined: (repo) => ({ chip: "Not a fit", text: `You said it's not a fit for ${repo}.` }),
  applied: (repo) => ({ chip: "Applied", text: `Applied in ${repo}.` }),
  done: (repo) => ({ chip: "Done", text: `Already done in ${repo}.` }),
  dead: (repo) => ({ chip: "Not offered", text: `Turned down twice, so xkg won't offer it in ${repo} again.` }),
};

export function handoffStatus(row: HandoffState | null): HandoffStatus {
  if (!row) return { chip: null, text: null, canHandOff: true };
  const { repo } = row;
  const status = row.status.trim().toLowerCase();
  const finished = FINISHED[status];
  if (finished) return { ...finished(repo), canHandOff: false };
  if (status === "expired") return { chip: "No answer", text: `Offered 3 times in ${repo} with no answer.`, canHandOff: true };
  if (status.startsWith("snoozed:")) {
    const until = shortDate(status.slice("snoozed:".length));
    return { chip: "Snoozed", text: `You said later. Your coding agent asks again${until ? ` after ${until}` : ""} in ${repo}.`, canHandOff: false };
  }
  // pending, or a status typed by hand: it's in the queue
  const on = shortDate(row.since);
  return { chip: "Sent", text: `Sent to your coding agent${on ? ` on ${on}` : ""}. It asks you at your next session in ${repo}.`, canHandOff: false };
}
