/**
 * The session-start offer: captures waiting in HANDOFFS.md for the repo the
 * agent is in, as one static text for every agent. It is what `briefing`
 * returns first when given `repo`, and what `xkg session-start` prints, so
 * pull and push give the same words.
 *
 *   HANDOFFS.md ──> offerable ──> expire (offered on 3 days, no answer) ──> formatOffer
 *                                                      │
 *                                     handoff_events (offered) + surface_events (handoff)
 *
 * The spec the agent writes stays in the code repo (.xkg/handoffs/), never in
 * xkg. Nothing here may tell the agent to send it.
 */

import type { User } from "./db";
import { codeMapPaths } from "./db";
import { readFile } from "./github";
import { formatDate } from "./llm";
import { captureName, HANDOFFS_PATH, parseHandoffs, setHandoffStatus, type HandoffRow } from "./handoffs";
import { offerDays, recordHandoffEvent, recordOffers } from "./handoff-events";
import { recordSurfaceEvents } from "./surface-events";
import { PROVENANCE } from "./where";

/** Captures listed per offer; the count line gives the total. */
export const MAX_OFFERED = 3;
/** Days a waiting capture is offered without an answer before it stops. */
export const EXPIRE_AFTER_DAYS = 3;

const FIT: Record<string, string> = { strong: "Strong fit", possible: "Possible fit" };

export interface OfferItem {
  capture: string;
  title: string;
  fit: string;
  /** `moved`: no longer in the repo's current map. */
  files: { path: string; moved: boolean }[];
}

/** Rows waiting in this repo: pending, or snoozed until today or earlier. Strong fits first, then oldest. */
export function offerable(rows: HandoffRow[], repo: string, today: string): HandoffRow[] {
  const waiting = (r: HandoffRow) =>
    r.status === "pending" || (r.status.startsWith("snoozed:") && r.status.slice("snoozed:".length) <= today);
  return rows
    .filter((r) => r.repo.toLowerCase() === repo.toLowerCase() && waiting(r))
    .map((r, i) => ({ r, i }))
    .sort((a, b) => Number(b.r.fit === "strong") - Number(a.r.fit === "strong") || a.r.since.localeCompare(b.r.since) || a.i - b.i)
    .map(({ r }) => r);
}

/** Rows offered on EXPIRE_AFTER_DAYS earlier days since they were queued. `days` is keyed by capture name. */
export function expiredRows(rows: HandoffRow[], days: Map<string, string[]>, today: string): HandoffRow[] {
  return rows.filter((r) => (days.get(captureName(r.capture)) ?? []).filter((d) => d >= r.since && d < today).length >= EXPIRE_AFTER_DAYS);
}

export const HANDOFF_GUIDE = `If the user says yes, list these, let them pick one, then follow "How to hand off" below.
If they say no or don't answer, carry on; don't ask again this session.

## How to hand off
1. Call read_capture with the filename. Open every listed file that exists.
2. Write the spec to .xkg/handoffs/<capture name>.md in this repo, using the template below.
   Add ".xkg/" to .git/info/exclude if it isn't there. Never commit this file, and never send its contents to xkg.
3. Show the user the claim, the files and the checks, then ask: "Apply this now?"
4. Yes: make the change in your normal way. Add "xkg-capture: <filename>" to the commit message.
   Not now, or no: carry on with the user's task.

## Template
# Apply: <capture title>
capture: <filename> · repo: <owner/name> · fit: <fit> (xkg)
## Claim
One sentence: what changes in this code, and what gets better.
## Evidence
1 to 3 quotes from the capture, word for word, with its source link.
## Why here
What in the files you opened makes this apply. Name functions you actually read.
## Files and changes
| File | Change | Opened |
Every row is a file you opened. If you chose different files than xkg suggested, say why.
## Verification Checklist
- [ ] A command or test that proves it worked, with the expected result.
## Confidence
High, Medium or Low, and one line on what would change your mind.
## Not doing
What is out of scope.
`;

function filesLine(files: OfferItem["files"]): string {
  if (!files.length) return "Files: none suggested; find where it applies in this repo.";
  const here = files.filter((f) => !f.moved).map((f) => f.path);
  const gone = files.filter((f) => f.moved).map((f) => f.path);
  const parts = [
    ...(here.length ? [`${here.join(", ")} (${PROVENANCE})`] : []),
    ...(gone.length ? [`${gone.join(", ")} moved or deleted since the capture; find where it applies now.`] : []),
  ];
  return `Files: ${parts.join(". ")}`;
}

export function formatOffer(repo: string, total: number, items: OfferItem[]): string {
  const ask = total === 1
    ? `xkg: 1 capture fits this repo (${repo}). Want to see it and apply it?`
    : `xkg: ${total} captures fit this repo (${repo}). Want to see them and apply one?`;
  const list = items
    .map((it, i) => `${i + 1}. ${it.title} · ${FIT[it.fit] ?? "Queued by you"} · ${it.capture}\n   ${filesLine(it.files)}\n`)
    .join("");
  return `${ask}\n\n## Waiting for you in ${repo}\n${list}\n${HANDOFF_GUIDE}`;
}

type OfferUser = Pick<User, "id" | "github_token" | "github_repo">;

/** The capture's title and where it is now (inbox/ or applied/), or null when it's gone. */
async function findCapture(user: OfferUser, capture: string): Promise<{ path: string; title: string } | null> {
  const name = captureName(capture);
  for (const path of [capture, `inbox/${name}`, `applied/${name}`].filter((p, i, all) => all.indexOf(p) === i)) {
    const file = await readFile(user.github_token, user.github_repo!, path);
    if (file) return { path, title: file.content.match(/^# (.+)$/m)?.[1]?.trim() || name.replace(/\.md$/, "") };
  }
  return null;
}

/**
 * The offer for `repo` (normalized owner/name), or null when nothing waits.
 * Rows offered on 3 earlier days with no answer are marked expired first.
 * Each shown capture is counted once a day. Never throws.
 */
export async function handoffOffer(user: OfferUser, repo: string): Promise<string | null> {
  try {
    if (!user.github_repo) return null;
    const file = await readFile(user.github_token, user.github_repo, HANDOFFS_PATH);
    if (!file) return null;
    const today = formatDate();
    let waiting = offerable(parseHandoffs(file.content).rows, repo, today);
    if (!waiting.length) return null;

    const days = await offerDays(user.id, repo, waiting.map((r) => r.capture));
    const expired = expiredRows(waiting, days, today);
    if (expired.length && (await setHandoffStatus(user.github_token, user.github_repo, expired, "expired"))) {
      await Promise.all(expired.map((r) => recordHandoffEvent(user.id, r.capture, repo, "expired")));
    }
    waiting = waiting.filter((r) => !expired.includes(r));

    // Captures deleted since they were queued are left out of the list and the
    // count. Only as many are read as the list needs.
    const shown: { r: HandoffRow; at: { path: string; title: string } }[] = [];
    let gone = 0;
    for (let next = 0; shown.length < MAX_OFFERED && next < waiting.length; ) {
      const batch = waiting.slice(next, next + MAX_OFFERED - shown.length);
      next += batch.length;
      for (const { r, at } of await Promise.all(batch.map(async (r) => ({ r, at: await findCapture(user, r.capture) })))) {
        if (at) shown.push({ r, at });
        else gone++;
      }
    }
    if (!shown.length) return null;

    const paths = await codeMapPaths(user.id, repo).catch(() => null);
    const items = shown.map(({ r, at }) => ({
      capture: at.path,
      title: at.title,
      fit: r.fit,
      files: r.files.map((path) => ({ path, moved: paths !== null && !paths.has(path) })),
    }));

    const fresh = shown.filter(({ r }) => !(days.get(captureName(r.capture)) ?? []).includes(today)).map(({ at }) => at.path);
    await Promise.all([recordOffers(user.id, repo, fresh), recordSurfaceEvents(user.id, items.map((it) => it.capture), "handoff")]);
    return formatOffer(repo, waiting.length - gone, items);
  } catch (err) {
    console.error("[handoff] offer failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
