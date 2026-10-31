import { test, expect, signIn, WORST_CAPTURE, WORST_ME, WORST_REPO, openSettings } from "./fixtures";

// Framing and copy (2026-10-24 review): say what xkg does, and show the next step.

const TAGLINE = "Learn it once. Your AI applies it.";
const FILE_URL = "https://github.com/ola/xkg-knowledge/blob/main/inbox/" + WORST_CAPTURE.filename;

test("the capture screen leads with the tagline and says how it works", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  await expect(page.getByText(TAGLINE, { exact: true })).toBeVisible();
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", TAGLINE);
});

test("the capture screen has no helper line under the composer", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  await expect(page.getByText(/Paste a link or a note|Paste anything you want your AI to know/)).toHaveCount(0);
  await expect(page.getByLabel("Content to capture")).toHaveAttribute("placeholder", /^Paste anything/);
});

test("login uses the same tagline", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByText(TAGLINE, { exact: true })).toBeVisible();
});

test("the result says where it was saved and what to do next", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/capture", (r) => r.fulfill({ json: { ...WORST_CAPTURE, fileUrl: FILE_URL } }));
  await page.goto("/");
  await page.getByLabel("Content to capture").fill("x");
  await page.getByRole("button", { name: "Capture", exact: true }).tap();
  await expect(page.getByText("Added to your knowledge")).toBeVisible();
  await expect(page.getByRole("link", { name: WORST_CAPTURE.filename })).toHaveAttribute("href", FILE_URL);
  await expect(page.getByText("Apply it", { exact: true })).toBeVisible();
  await expect(page.getByText(/brief me on what I saved today/)).toBeVisible();
});

test("a failed capture says what failed and what to do", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/capture", (r) => r.fulfill({ status: 503, body: "upstream down" }));
  await page.goto("/");
  await page.getByLabel("Content to capture").fill("x");
  await page.getByRole("button", { name: "Capture", exact: true }).tap();
  await expect(page.locator("main").getByRole("alert")).toHaveText("Couldn't capture that. Try again in a moment.");
});

test("Settings gives the connector URL for Claude and ChatGPT on the web", async ({ page, baseURL }) => {
  await signIn(page);
  await page.goto("/");
  await openSettings(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(`${baseURL}/api/mcp`, { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Copy URL" })).toBeVisible();
});

test("the Capture label doesn't animate on page load", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  const label = page.getByRole("button", { name: "Capture", exact: true }).locator("[data-label]");
  await expect(label).toHaveCSS("animation-name", "none");
});

test("with reduced motion Settings fades instead of sliding", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signIn(page);
  await page.goto("/");
  await openSettings(page);
  const panel = page.getByRole("dialog");
  await expect(panel).toBeVisible();
  const t = await panel.evaluate((el) => {
    const s = getComputedStyle(el);
    return { property: s.transitionProperty, duration: s.transitionDuration, transform: s.transform };
  });
  expect(t).toEqual({ property: "opacity", duration: "0.2s", transform: "none" });
});

test("Settings says where captures are stored and links to the repo", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  await openSettings(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Captures are saved in", { exact: true })).toBeVisible();
  const link = dialog.getByRole("link", { name: WORST_REPO });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", `https://github.com/${WORST_REPO}`);
});

test("Settings leaves out the repo row before onboarding", async ({ page }) => {
  await signIn(page, { ...WORST_ME, knowledgeRepo: null });
  await page.goto("/");
  await openSettings(page);
  await expect(page.getByRole("dialog").getByText("Captures are saved in")).toHaveCount(0);
});
