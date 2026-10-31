import { test, expect, signIn, openMenu } from "./fixtures";
import type { Page } from "@playwright/test";

// Your knowledge page: the human decisions that used to be MCP tools (archive,
// delete, check links, rules per tag, weekly applies), where the human is.

const LONG = "2026-10-24-why-retrieval-augmented-generation-pipelines-fail-in-production-a-field-guide.md";
const CAPTURES = [
  { date: "2026-10-28", slug: "llm-memory", filename: "2026-10-28-llm-memory.md", status: "inbox", summary: "Memory goes into the prompt, so keep it small.", tags: ["llm", "memory"], type: "article" },
  { date: "2026-10-24", slug: "rag", filename: LONG, status: "inbox", summary: "Most failures come from retrieval, not generation. https://northwind-industries-holdings.example.com/blog/2026/10/retrieval-augmented-generation-evaluation-harness", tags: ["retrieval-augmented-generation-evaluation-harness-open-source"], type: null },
  { date: "2026-10-20", slug: "routing", filename: "2026-10-20-routing.md", status: "applied", summary: "Route by cost.", tags: ["llm"], type: "post" },
];
const WEEKS = [
  { weekStart: "2026-10-26", applied: 3, withCommit: 2 },
  { weekStart: "2026-10-19", applied: 1, withCommit: 1 },
  { weekStart: "2026-10-12", applied: 0, withCommit: 0 },
  { weekStart: "2026-10-05", applied: 0, withCommit: 0 },
];

async function open(page: Page) {
  await signIn(page);
  await page.route("**/api/captures", (r) => r.fulfill({ json: { captures: CAPTURES } }));
  await page.route("**/api/apply-stats", (r) => r.fulfill({ json: { weeks: WEEKS } }));
  await page.goto("/knowledge");
}

test("the menu on home goes to Your knowledge, and back to Capture", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/captures", (r) => r.fulfill({ json: { captures: CAPTURES } }));
  await page.route("**/api/apply-stats", (r) => r.fulfill({ json: { weeks: WEEKS } }));
  await page.goto("/");
  await openMenu(page);
  await page.getByRole("dialog").getByRole("link", { name: /Your knowledge/ }).tap();
  await expect(page).toHaveURL(/\/knowledge$/);
  await expect(page.getByRole("heading", { name: "Your knowledge" })).toBeVisible();
  await openMenu(page);
  await expect(page.getByRole("dialog").getByRole("link", { name: /Your knowledge/ })).toHaveAttribute("aria-current", "page");
  await page.getByRole("dialog").getByRole("link", { name: "Capture", exact: true }).tap();
  await expect(page).toHaveURL(/\/$/);
  // The menu replaces its own history entry, so Back steps through pages, not menus.
  await page.goBack();
  await expect(page).toHaveURL(/\/knowledge$/);
});

test("the inbox lists its captures, and the weekly applies show", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("heading", { name: "Your knowledge" })).toBeVisible();
  await expect(page.getByText("3 applied this week, 2 with a commit")).toBeVisible();
  const list = page.getByTestId("capture-list");
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await page.getByRole("tab", { name: "Applied" }).tap();
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list.getByText("Route by cost.")).toBeVisible();
});

test("archive takes a capture out of the inbox", async ({ page }) => {
  await open(page);
  const sent: unknown[] = [];
  await page.route("**/api/captures/archive", async (r) => {
    sent.push(r.request().postDataJSON());
    await r.fulfill({ json: { ok: true } });
  });
  const row = page.getByTestId("capture-list").getByRole("listitem").filter({ hasText: "Memory goes into the prompt" });
  await row.getByRole("button", { name: "Archive" }).tap();
  await expect(page.getByTestId("capture-list").getByRole("listitem")).toHaveCount(1);
  expect(sent).toEqual([{ filename: "2026-10-28-llm-memory.md" }]);
  await page.getByRole("tab", { name: "Archived" }).tap();
  await expect(page.getByTestId("capture-list").getByText("Memory goes into the prompt")).toBeVisible();
});

test("delete asks first, then removes the capture for good", async ({ page }) => {
  await open(page);
  const sent: unknown[] = [];
  await page.route("**/api/captures/delete", async (r) => {
    sent.push(r.request().postDataJSON());
    await r.fulfill({ json: { ok: true } });
  });
  const row = page.getByTestId("capture-list").getByRole("listitem").filter({ hasText: "Memory goes into the prompt" });
  await row.getByRole("button", { name: "Delete" }).tap();
  expect(sent).toEqual([]);
  await row.getByRole("button", { name: "Delete for good" }).tap();
  await expect(page.getByTestId("capture-list").getByRole("listitem")).toHaveCount(1);
  expect(sent).toEqual([{ filename: "2026-10-28-llm-memory.md" }]);
});

test("a failed archive says why and keeps the capture", async ({ page }) => {
  await open(page);
  await page.route("**/api/captures/archive", (r) => r.fulfill({ status: 404, json: { error: "That capture isn't in your inbox anymore." } }));
  const row = page.getByTestId("capture-list").getByRole("listitem").filter({ hasText: "Memory goes into the prompt" });
  await row.getByRole("button", { name: "Archive" }).tap();
  await expect(row.getByRole("alert")).toHaveText("That capture isn't in your inbox anymore.");
  await expect(page.getByTestId("capture-list").getByRole("listitem")).toHaveCount(2);
});

test("check links flags captures whose source is gone", async ({ page }) => {
  await open(page);
  await page.route("**/api/captures/check", (r) => r.fulfill({ json: {
    results: [
      { filename: "2026-10-28-llm-memory.md", status: "ok", httpStatus: 200, reason: "" },
      { filename: LONG, status: "stale_and_low_confidence", httpStatus: 404, reason: "x" },
    ],
    total: 2, next: null,
  } }));
  await page.getByRole("button", { name: "Check links" }).tap();
  await expect(page.getByText("1 of 2 need a look.")).toBeVisible();
  const row = page.getByTestId("capture-list").getByRole("listitem").filter({ hasText: "Most failures" });
  await expect(row.getByText("Source is gone · Low confidence")).toBeVisible();
});

test("make rules turns a tag into rules", async ({ page }) => {
  await open(page);
  const sent: unknown[] = [];
  await page.route("**/api/rules", async (r) => {
    sent.push(r.request().postDataJSON());
    await r.fulfill({ json: { topic: "llm", rules: ["Keep memory small.", "Route by cost."] } });
  });
  await page.getByLabel("Tag").selectOption("llm");
  await page.getByRole("button", { name: "Make rules" }).tap();
  await expect(page.getByText("Keep memory small.")).toBeVisible();
  expect(sent).toEqual([{ tag: "llm" }]);
});

test("Your knowledge has no sideways scroll at 320 px", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("capture-list").getByRole("listitem")).toHaveCount(2);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBe(0);
});

test("checking more links after an archive still checks the rest", async ({ page }) => {
  const many = Array.from({ length: 21 }, (_, i) => ({
    date: `2026-09-${String(i + 1).padStart(2, "0")}`, slug: `c${i}`, filename: `2026-09-${String(i + 1).padStart(2, "0")}-c${i}.md`,
    status: "inbox", summary: `Capture number ${i}.`, tags: [], type: null,
  }));
  await signIn(page);
  await page.route("**/api/captures", (r) => r.fulfill({ json: { captures: many } }));
  await page.route("**/api/apply-stats", (r) => r.fulfill({ json: { weeks: WEEKS } }));
  await page.route("**/api/captures/archive", (r) => r.fulfill({ json: { ok: true } }));
  const offsets: unknown[] = [];
  await page.route("**/api/captures/check", async (r) => {
    const { offset } = r.request().postDataJSON() as { offset: number };
    offsets.push(offset);
    const page1 = many.slice(0, 20).map((c) => ({ filename: c.filename, status: "ok", httpStatus: 200, reason: "" }));
    await r.fulfill({ json: offset === 0 ? { results: page1, total: 21, next: 20 } : { results: [{ filename: many[20]!.filename, status: "ok", httpStatus: 200, reason: "" }], total: 20, next: null } });
  });
  await page.goto("/knowledge");
  await page.getByRole("button", { name: "Check links" }).tap();
  await expect(page.getByRole("button", { name: "Check more links" })).toBeVisible();
  await page.getByTestId("capture-list").getByRole("listitem").filter({ hasText: "Capture number 3." }).getByRole("button", { name: "Archive" }).tap();
  await expect(page.getByTestId("capture-list").getByRole("listitem")).toHaveCount(20);
  await page.getByRole("button", { name: "Check more links" }).tap();
  await expect(page.getByText("0 of 20 need a look.")).toBeVisible();
  expect(offsets).toEqual([0, 19]);
});

test("make rules uses a tag that still exists after its last capture is deleted", async ({ page }) => {
  await open(page);
  await page.route("**/api/captures/delete", (r) => r.fulfill({ json: { ok: true } }));
  const sent: unknown[] = [];
  await page.route("**/api/rules", async (r) => {
    sent.push(r.request().postDataJSON());
    await r.fulfill({ json: { topic: "llm", rules: ["Keep memory small."] } });
  });
  await page.getByLabel("Tag").selectOption("memory");
  const row = page.getByTestId("capture-list").getByRole("listitem").filter({ hasText: "Memory goes into the prompt" });
  await row.getByRole("button", { name: "Delete" }).tap();
  await row.getByRole("button", { name: "Delete for good" }).tap();
  await expect(page.getByTestId("capture-list").getByRole("listitem")).toHaveCount(1);
  await page.getByRole("button", { name: "Make rules" }).tap();
  await expect(page.getByText("Keep memory small.")).toBeVisible();
  expect(sent).toEqual([{ tag: "llm" }]);
});
