import { describe, it, expect } from "vitest";
import { handoffStatus, shortDate } from "../handoff-status";

/**
 * What the capture card says about a capture's handoff in one repo: whether
 * it was already sent, and what the user can still do about it.
 */

const REPO = "acme/app";

describe("handoffStatus", () => {
  // fails_when: a queued capture reads like a missing button again (no date, no next step)
  it("says a queued capture was already sent, when, and what happens next", () => {
    expect(handoffStatus({ repo: REPO, status: "pending", since: "2026-11-02" })).toEqual({
      chip: "Sent",
      text: "Sent to your coding agent on Nov 2. It asks you at your next session in acme/app.",
      canHandOff: false,
      canDecline: true,
    });
  });

  it("says when a snoozed capture comes back", () => {
    expect(handoffStatus({ repo: REPO, status: "snoozed:2026-11-10", since: "2026-11-02" })).toMatchObject({
      chip: "Snoozed",
      text: "You said later. Your coding agent asks again after Nov 10 in acme/app.",
      canHandOff: false,
      canDecline: true,
    });
  });

  it("says an expired offer got no answer, and lets the user hand it off again", () => {
    expect(handoffStatus({ repo: REPO, status: "expired", since: "2026-11-01" })).toMatchObject({
      chip: "No answer",
      text: "Offered 3 times in acme/app with no answer.",
      canHandOff: true,
      canDecline: true,
    });
  });

  it.each([
    ["declined", "Not a fit", "You said it's not a fit for acme/app."],
    ["applied", "Applied", "Applied in acme/app."],
    ["done", "Done", "Already done in acme/app."],
    ["dead", "Not offered", "Turned down twice, so xkg won't offer it in acme/app again."],
  ])("a finished row (%s) offers nothing more", (status, chip, text) => {
    expect(handoffStatus({ repo: REPO, status, since: "2026-11-01" })).toEqual({ chip, text, canHandOff: false, canDecline: false });
  });

  // fails_when: a decline whose Handoff log line failed hides "Not a fit" after a reload, so it can never be finished
  it("keeps Not a fit for a decline that isn't in the Handoff log yet", () => {
    expect(handoffStatus({ repo: REPO, status: "declined", since: "2026-11-03", unfinished: true })).toEqual({
      chip: "Not a fit",
      text: "You said it's not a fit for acme/app. It isn't fully saved yet, so answer again to finish.",
      canHandOff: false,
      canDecline: true,
    });
  });

  it("with no row, offers the handoff and the decline", () => {
    expect(handoffStatus(null)).toEqual({ chip: null, text: null, canHandOff: true, canDecline: true });
  });

  it("treats a status typed by hand as waiting, without inventing a date", () => {
    expect(handoffStatus({ repo: REPO, status: "pending", since: "—" }).text).toBe("Sent to your coding agent. It asks you at your next session in acme/app.");
  });
});

describe("shortDate", () => {
  it("names the month and day, in UTC", () => {
    expect(shortDate("2026-11-02")).toBe("Nov 2");
    expect(shortDate("2026-01-31")).toBe("Jan 31");
  });

  it("gives null for anything that isn't a date", () => {
    expect(shortDate("—")).toBeNull();
    expect(shortDate("")).toBeNull();
  });
});
