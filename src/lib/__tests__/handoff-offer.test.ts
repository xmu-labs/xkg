import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import type { HandoffRow } from "../handoffs";
import { offerable, formatOffer, expiredRows, HANDOFF_GUIDE } from "../handoff-offer";

/**
 * The session-start offer: captures waiting in HANDOFFS.md for this repo, as
 * one static text every agent gets, whether it asks for a briefing itself or
 * a session-start hook prints it.
 */

const row = (over: Partial<HandoffRow> = {}): HandoffRow => ({
  capture: "inbox/2026-10-29-llm-memory.md", repo: "acme/app", kind: "code", files: ["src/llm.ts"],
  fit: "strong", status: "pending", since: "2026-10-29", source: "auto", ...over,
});

describe("offerable", () => {
  // protects: AC6, waiting rows for this repo only, strong first then oldest, pending or snoozed until today; fails_when: another repo, a finished row or a future snooze is offered, or the order differs; no_claim: none
  it("picks this repo's waiting rows, Strong first, then oldest", () => {
    const rows = [
      row({ capture: "inbox/d.md", fit: "possible", since: "2026-10-20" }),
      row({ capture: "inbox/c.md", since: "2026-10-28" }),
      row({ capture: "inbox/b.md", since: "2026-10-25" }),
      row({ capture: "inbox/other.md", repo: "acme/web" }),
      row({ capture: "inbox/done.md", status: "applied" }),
      row({ capture: "inbox/dead.md", status: "dead" }),
      row({ capture: "inbox/later.md", status: "snoozed:2026-11-05" }),
      row({ capture: "inbox/back.md", status: "snoozed:2026-10-29", fit: "possible", since: "2026-10-01" }),
    ];
    expect(offerable(rows, "acme/app", "2026-10-29").map((r) => r.capture)).toEqual(["inbox/b.md", "inbox/c.md", "inbox/back.md", "inbox/d.md"]);
  });

  // protects: owner/name from any agent matches the stored repo; fails_when: "Acme/App" misses "acme/app"; no_claim: none
  it("matches the repo whatever its case", () => {
    expect(offerable([row()], "ACME/App", "2026-10-29")).toHaveLength(1);
  });
});

describe("expiredRows", () => {
  // protects: AC8, a row offered on 3 days with no answer stops; fails_when: it expires earlier, or offers before it was queued count; no_claim: how days are recorded (handler test)
  it("expires a row offered on 3 earlier days since it was queued", () => {
    const r = row({ since: "2026-10-20" });
    const days = (d: string[]) => new Map([["2026-10-29-llm-memory.md", d]]);
    expect(expiredRows([r], days(["2026-10-21", "2026-10-22", "2026-10-23"]), "2026-10-29")).toEqual([r]);
    expect(expiredRows([r], days(["2026-10-21", "2026-10-22"]), "2026-10-29")).toEqual([]);
    expect(expiredRows([r], days(["2026-10-21", "2026-10-22", "2026-10-29"]), "2026-10-29")).toEqual([]);
    expect(expiredRows([r], days(["2026-10-01", "2026-10-02", "2026-10-21"]), "2026-10-29")).toEqual([]);
  });

  // protects: "not now" gives the capture a fresh start; fails_when: offers from before the snooze ended still count toward expiry; no_claim: none
  it("counts only offers since a snooze ended", () => {
    const r = row({ status: "snoozed:2026-11-05", since: "2026-10-29" });
    const days = (d: string[]) => new Map([["2026-10-29-llm-memory.md", d]]);
    expect(expiredRows([r], days(["2026-10-29", "2026-11-05", "2026-11-06"]), "2026-11-07")).toEqual([]);
    expect(expiredRows([r], days(["2026-10-29", "2026-11-05", "2026-11-06", "2026-11-07"]), "2026-11-08")).toEqual([r]);
  });
});

describe("formatOffer", () => {
  const items = [
    { capture: "inbox/2026-10-29-llm-memory.md", title: "LLM memory trade-offs", fit: "strong", files: [{ path: "src/llm.ts", moved: false }, { path: "src/briefing.ts", moved: false }] },
    { capture: "inbox/2026-10-28-review.md", title: "Adversarial review", fit: "possible", files: [{ path: "src/where.ts", moved: true }] },
    { capture: "inbox/2026-10-27-flow.md", title: "Release flow", fit: "none", files: [] },
  ];

  // protects: AC6, the exact first line with the total, then up to 3 rows; fails_when: the count, wording or order changes; no_claim: how agents phrase it to the user
  it("leads with the count and the question, then lists each capture with its files", () => {
    const text = formatOffer("acme/app", 4, items);
    expect(text.split("\n")[0]).toBe("xkg: 4 captures fit this repo (acme/app). Want to see them and apply one?");
    expect(text).toContain(
      "## Waiting for you in acme/app\n" +
        "1. LLM memory trade-offs · Strong fit · inbox/2026-10-29-llm-memory.md\n" +
        "   Files: src/llm.ts, src/briefing.ts (from file names, not yet checked in your code)\n" +
        "2. Adversarial review · Possible fit · inbox/2026-10-28-review.md\n" +
        "   Files: src/where.ts moved or deleted since the capture; find where it applies now.\n" +
        "3. Release flow · Queued by you · inbox/2026-10-27-flow.md\n" +
        "   Files: none suggested; find where it applies in this repo.\n",
    );
    expect(text.endsWith(HANDOFF_GUIDE)).toBe(true);
  });

  // protects: one capture reads naturally; fails_when: "1 captures fit"; no_claim: none
  it("says capture, not captures, for one", () => {
    expect(formatOffer("acme/app", 1, items.slice(0, 1)).split("\n")[0]).toBe("xkg: 1 capture fits this repo (acme/app). Want to see it and apply it?");
  });

  // protects: AC7, files still in the map and moved ones are told apart in one line; fails_when: a moved file is offered as if it exists; no_claim: none
  it("labels moved and existing files separately", () => {
    const text = formatOffer("acme/app", 1, [{ ...items[0]!, files: [{ path: "src/llm.ts", moved: false }, { path: "src/old.ts", moved: true }] }]);
    expect(text).toContain("   Files: src/llm.ts (from file names, not yet checked in your code). src/old.ts moved or deleted since the capture; find where it applies now.\n");
  });
});

describe("HANDOFF_GUIDE", () => {
  // protects: AC17 and D3, one text for every agent, and the spec never leaves the machine; fails_when: an agent is named or the text invites sending the spec to xkg; no_claim: agents obey it
  it("names no agent, keeps the spec local, and carries the template", () => {
    expect(HANDOFF_GUIDE).not.toMatch(/claude|codex|cursor|gemini|copilot|aider|windsurf/i);
    expect(HANDOFF_GUIDE).toContain(".xkg/handoffs/");
    expect(HANDOFF_GUIDE).toContain(".git/info/exclude");
    expect(HANDOFF_GUIDE).toContain("never send its contents to xkg");
    expect(HANDOFF_GUIDE).toContain("## Verification Checklist\n- [ ]");
    expect(HANDOFF_GUIDE).toContain("xkg-capture: <filename>");
  });

  // protects: AC10, "not now" and "no" are recorded as answers, never as an apply; fails_when: a refusal is sent without its outcome, or no reason is asked for; no_claim: agents follow it
  it("records a refusal as later or declined, with a reason", () => {
    const line = (start: string) => HANDOFF_GUIDE.split("\n").find((l) => l.trim().startsWith(start)) ?? "";
    expect(line("Not now:")).toMatch(/apply_capture[^.]*outcome "later"/);
    expect(line("No:")).toMatch(/apply_capture[^.]*outcome "declined"[^.]*reason \(wrong-files, doesnt-fit or other\)/);
    expect(line("Already done:")).toMatch(/outcome "done"/);
    for (const start of ["Not now:", "No:", "Already done:"]) expect(line(start)).toContain("repo");
  });
});

describe("handoff code", () => {
  const FILES = [
    "src/lib/handoffs.ts", "src/lib/handoff-offer.ts", "src/lib/handoff-outcomes.ts", "src/lib/handoff-events.ts",
    "src/app/api/handoffs/route.ts", "src/components/HandOff.tsx",
  ];

  // protects: AC17, the handoff works the same for every agent and never touches an agent's own config; fails_when: one of these files names an agent's config folder; no_claim: code outside these files
  it("never reads or writes an agent's config folder", () => {
    for (const file of FILES) {
      expect(readFileSync(join(process.cwd(), file), "utf-8"), file).not.toMatch(/~?\/?\.(claude|codex|gemini|copilot|cursor)\b/);
    }
  });
});
