import { describe, it, expect, vi, beforeEach } from "vitest";
import type { User } from "../db";

/**
 * XKG-189. A chat app sends no repo, so a briefing there can't know where the
 * user works: it tells the AI to ask once, naming the user's known repos,
 * instead of guessing. And wherever xkg lists or opens a capture (chat
 * briefing, search, read_capture), a capture already handed off says so,
 * with its repo and state, so the AI doesn't offer a new fit check.
 *
 * Not covered: the offer itself (briefing-handoff test), ranking (mocked).
 */

const files: Record<string, string> = {};
const codeMapRepos = vi.fn();

vi.mock("../rate-limit", () => ({ consumeQuota: vi.fn() }));
vi.mock("../llm", async (orig) => ({ ...(await orig<typeof import("../llm")>()), formatDate: () => "2026-11-04" }));
vi.mock("../github", () => ({
  githubGet: vi.fn(),
  githubPut: vi.fn(),
  githubDelete: vi.fn(),
  readFile: async (_t: string, _r: string, path: string) => (path in files ? { content: files[path], sha: "s" } : null),
  readFileStrict: async (_t: string, _r: string, path: string) => (path in files ? { content: files[path], sha: "s" } : null),
  updateIndexEntry: vi.fn(),
}));
vi.mock("../db", async (orig) => ({ ...(await orig<typeof import("../db")>()), codeMapRepos: (...a: unknown[]) => codeMapRepos(...a), codeMapPaths: vi.fn() }));
vi.mock("../surface-events", () => ({ recordSurfaceEvents: vi.fn(), recordWhereEvent: vi.fn() }));
vi.mock("../setup-steps", () => ({ recordSetupStep: vi.fn() }));
vi.mock("../handoff-events", () => ({ offerDays: vi.fn(), recordOffers: vi.fn(), recordHandoffEvent: vi.fn() }));
vi.mock("../linking", () => ({ linkCapture: vi.fn() }));
vi.mock("../synthesis", () => ({ synthesizeTopic: vi.fn() }));
vi.mock("../apply-events", async (orig) => ({ ...(await orig<typeof import("../apply-events")>()), recordApplyEvent: vi.fn() }));

const { handleBriefing, handleSearch, handleReadCapture } = await import("../mcp/handlers");
const { handoffNote } = await import("../handoff-offer");
const { renderHandoffs } = await import("../handoffs");
type Row = import("../handoffs").HandoffRow;

const user = { id: 1, github_token: "t", github_repo: "o/r", llm_api_key: "k" } as unknown as User;
const ROUTING = "2026-11-04-smart-model-routing.md";
const CI = "2026-11-04-scaling-ci.md";
const row = (name: string, over: Partial<Row> = {}): Row => ({
  capture: `inbox/${name}`, repo: "xmu-labs/xmu-monorepo", kind: "code", files: ["src/llm.ts"], fit: "strong", status: "pending", since: "2026-11-03", source: "button", ...over,
});

function setup(rows: Row[]) {
  for (const k of Object.keys(files)) delete files[k];
  files["INDEX.md"] = [
    "| Date | Title | Summary | Tags | Type |",
    "|---|---|---|---|---|",
    `| 2026-11-04 | [Smart model routing](inbox/${ROUTING}) | Route each call to the cheapest model... | llm | url |`,
    `| 2026-11-04 | [Scaling CI](inbox/${CI}) | Run only the tests a change touches... | ci | url |`,
  ].join("\n");
  files[`inbox/${ROUTING}`] = "# Smart model routing\n\n## Core idea\nCheap model first.\n";
  files[`inbox/${CI}`] = "# Scaling CI\n\n## Core idea\nTest impact analysis.\n";
  if (rows.length) files["HANDOFFS.md"] = renderHandoffs(rows);
}

beforeEach(() => {
  codeMapRepos.mockReset().mockResolvedValue([]);
});

describe("handoffNote", () => {
  it("names each repo and its state, and skips dead rows", () => {
    const rows = [
      row(ROUTING),
      row(ROUTING, { repo: "xmu-labs/xkg", status: "applied" }),
      row(ROUTING, { repo: "a/b", status: "dead" }),
    ];
    expect(handoffNote(rows, ROUTING, "2026-11-04")).toBe(
      "handed off to xmu-labs/xmu-monorepo (waiting for the coding agent there), xmu-labs/xkg (applied)",
    );
    expect(handoffNote(rows, CI, "2026-11-04")).toBeNull();
    expect(handoffNote([row(ROUTING, { status: "dead" })], ROUTING, "2026-11-04")).toBeNull();
  });

  it("treats a snooze that has ended as waiting", () => {
    expect(handoffNote([row(ROUTING, { status: "snoozed:2026-11-10" })], ROUTING, "2026-11-04")).toBe(
      "handed off to xmu-labs/xmu-monorepo (snoozed until 2026-11-10)",
    );
    expect(handoffNote([row(ROUTING, { status: "snoozed:2026-11-01" })], ROUTING, "2026-11-04")).toBe(
      "handed off to xmu-labs/xmu-monorepo (waiting for the coding agent there)",
    );
  });
});

describe("chat briefing (no arguments)", () => {
  // protects: XKG-189 gap 2, the chat offered a fit check for a capture already handed off; fails_when: the listed capture carries no handoff tag; no_claim: offer wording
  it("tags a listed capture that was handed off, and leaves the others alone", async () => {
    setup([row(ROUTING)]);
    const text = await handleBriefing(user, {});
    expect(text).toContain(`- ${ROUTING}: Route each call to the cheapest model (handed off to xmu-labs/xmu-monorepo (waiting for the coding agent there))`);
    expect(text).toContain(`- ${CI}: Run only the tests a change touches\n`);
  });

  // protects: XKG-189 gap 1, the chat guessed "xmu-monorepo or xkg"; fails_when: no ask-once instruction, or known repos aren't named; no_claim: that the AI obeys
  it("tells the AI to ask once which repo, naming the user's known repos", async () => {
    setup([row(ROUTING)]);
    codeMapRepos.mockResolvedValue(["xmu-labs/xkg", "xmu-labs/xmu-monorepo"]);
    const text = await handleBriefing(user, {});
    expect(text).toMatch(/ask the user once which repo they're working in \(xmu-labs\/xmu-monorepo, xmu-labs\/xkg\), then call briefing with repo set to it/);
    expect(text).toContain("say it was handed off instead of checking its fit again");
  });

  it("still asks for the repo when no repo is known yet, without a list", async () => {
    setup([]);
    const text = await handleBriefing(user, {});
    expect(text).toContain("ask the user once which repo they're working in, then call briefing with repo set to it");
  });

  it("keeps working when the code map lookup fails", async () => {
    setup([row(ROUTING)]);
    codeMapRepos.mockRejectedValue(new Error("db down"));
    expect(await handleBriefing(user, {})).toContain("(xmu-labs/xmu-monorepo)");
  });
});

describe("search and read_capture", () => {
  it("search tags a row whose capture was handed off", async () => {
    setup([row(ROUTING, { status: "declined" })]);
    const text = await handleSearch(user, {});
    const lines = text.split("\n");
    const at = lines.findIndex((l) => l.includes(ROUTING));
    expect(lines[at + 1]).toBe("  ↳ handed off to xmu-labs/xmu-monorepo (declined)");
    expect(text.split("↳")).toHaveLength(2);
  });

  it("search with no HANDOFFS.md answers as before", async () => {
    setup([]);
    expect(await handleSearch(user, {})).not.toContain("↳");
  });

  it("read_capture ends a handed-off capture with its state", async () => {
    setup([row(ROUTING)]);
    const text = await handleReadCapture(user, { filename: ROUTING });
    expect(text.startsWith("# Smart model routing")).toBe(true);
    expect(text.endsWith("\n\n---\nxkg: handed off to xmu-labs/xmu-monorepo (waiting for the coding agent there). It is applied from a coding session in that repo.")).toBe(true);
  });

  it("read_capture leaves other files untouched", async () => {
    setup([row(ROUTING)]);
    expect(await handleReadCapture(user, { filename: CI })).toBe(files[`inbox/${CI}`]);
    files["RULES.md"] = "# Rules";
    expect(await handleReadCapture(user, { filename: "RULES.md" })).toBe("# Rules");
  });
});
