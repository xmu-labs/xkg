import { test, expect, signIn } from "./fixtures";
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

test("home links to Your knowledge", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  await page.getByRole("link", { name: "Your knowledge" }).tap();
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

// The capture page: tap a card to read the whole capture again.

const LONG_URL = "https://northwind-industries-holdings.example.com/blog/2026/10/retrieval-augmented-generation-evaluation-harness";
const DETAIL = {
  filename: LONG, status: "inbox", title: `Why RAG pipelines fail in production ${LONG_URL}`, date: "2026-10-24", type: "blog",
  tags: ["retrieval-augmented-generation-evaluation-harness-open-source", "llm"], url: LONG_URL, lowConfidence: false,
  coreIdea: `Most failures come from retrieval, not generation. ${LONG_URL}`,
  takeaways: ["Measure recall@k before tuning prompts.", "<script>window.pwned = true</script>"],
  quotes: ["Retrieval is the bottleneck."],
  advice: "Add a recall check to the eval suite.",
  where: {
    fit: "Possible fit", repo: "northwind/retrieval-augmented-generation-evaluation-harness",
    files: [{ path: "packages/retrieval-augmented-generation-evaluation-harness/src/pipelines/production/retrievalRecallAtKEvaluator.ts", why: "measures `recallAtK`", after: "recall is checked before prompts" }],
    also: [], note: "From file names, not yet checked in your code",
  },
  evidence: [{ label: "Core idea", quotes: ["Retrieval failed first. (s3)"] }],
  applications: [],
  links: [{ name: "2026-10-28-llm-memory.md", slug: "llm-memory", note: "Both are about context.", summary: "Memory goes into the prompt, so keep it small." }],
  fileUrl: `https://github.com/o/k/blob/main/inbox/${LONG}`,
};
const MEMORY = { ...DETAIL, filename: "2026-10-28-llm-memory.md", status: "applied", title: "LLM memory", links: [], url: null,
  applications: [{ date: "2026-10-29", commit: "3f9a2c1d4e5f", target: "src/lib/memory.ts", note: null, outcome: "worked" }] };

async function openDetail(page: Page) {
  await open(page);
  await page.route("**/api/captures/read?*", (r) => {
    const name = new URL(r.request().url()).searchParams.get("name");
    if (name === LONG) return r.fulfill({ json: { capture: DETAIL } });
    if (name === MEMORY.filename) return r.fulfill({ json: { capture: MEMORY } });
    return r.fulfill({ status: 404, json: { error: "This capture isn't in your knowledge repo anymore." } });
  });
}

test("tapping a card opens the whole capture", async ({ page }) => {
  await openDetail(page);
  await page.getByTestId("capture-list").getByRole("link").filter({ hasText: "Most failures" }).tap();
  await expect(page).toHaveURL(new RegExp(`/knowledge/${LONG.replace(/\.md$/, "")}$`));
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Why RAG pipelines fail");
  await expect(page.getByText("Measure recall@k before tuning prompts.")).toBeVisible();
  await expect(page.getByText("Retrieval is the bottleneck.")).toBeVisible();
  await expect(page.getByTestId("where")).toContainText("recall is checked before prompts");
  await expect(page.getByText("Add a recall check to the eval suite.")).toBeVisible();
  await expect(page.getByRole("link", { name: /Read the source on northwind-industries-holdings/ })).toHaveAttribute("href", LONG_URL);
  // Markup in a capture is text, never HTML.
  await expect(page.getByText("<script>window.pwned = true</script>")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { pwned?: boolean }).pwned)).toBeUndefined();
  // Evidence stays folded until asked for.
  await expect(page.getByText("Retrieval failed first. (s3)")).toBeHidden();
  await page.getByText("Show evidence").tap();
  await expect(page.getByText("Retrieval failed first. (s3)")).toBeVisible();
});

test("a capture page has no sideways scroll at 320 px", async ({ page }) => {
  await openDetail(page);
  await page.goto(`/knowledge/${LONG.replace(/\.md$/, "")}`);
  await expect(page.getByTestId("links")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBe(0);
});

test("a link to memory opens that capture, and Back returns to its tab", async ({ page }) => {
  await openDetail(page);
  await page.goto(`/knowledge/${LONG.replace(/\.md$/, "")}`);
  await page.getByTestId("links").getByRole("link", { name: /Memory goes into the prompt/ }).tap();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("LLM memory");
  await expect(page.getByTestId("applied")).toContainText("3f9a2c1");
  await expect(page.getByRole("button", { name: "Archive" })).toHaveCount(0);
  await page.getByRole("link", { name: "← Your knowledge" }).tap();
  await expect(page).toHaveURL(/\/knowledge\?tab=applied$/);
  await expect(page.getByRole("tab", { name: /Applied/ })).toHaveAttribute("aria-selected", "true");
});

test("browser Back from a capture keeps the tab you were on", async ({ page }) => {
  await openDetail(page);
  await page.getByRole("tab", { name: /Applied/ }).tap();
  await page.getByTestId("capture-list").getByRole("link").filter({ hasText: "Route by cost." }).tap();
  await expect(page).toHaveURL(/\/knowledge\/2026-10-20-routing$/);
  await page.goBack();
  await expect(page.getByRole("tab", { name: /Applied/ })).toHaveAttribute("aria-selected", "true");
});

test("archive on the capture page goes back to the inbox", async ({ page }) => {
  await openDetail(page);
  const sent: unknown[] = [];
  await page.route("**/api/captures/archive", async (r) => {
    sent.push(r.request().postDataJSON());
    await r.fulfill({ json: { ok: true } });
  });
  await page.goto(`/knowledge/${LONG.replace(/\.md$/, "")}`);
  await page.getByRole("button", { name: "Archive" }).tap();
  await expect(page).toHaveURL(/\/knowledge$/);
  expect(sent).toEqual([{ filename: LONG }]);
});

test("a capture that is gone says so", async ({ page }) => {
  await openDetail(page);
  await page.goto("/knowledge/2026-01-01-gone");
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("This capture isn't in your knowledge repo anymore.");
  await expect(page.getByRole("link", { name: "← Your knowledge" })).toBeVisible();
});
