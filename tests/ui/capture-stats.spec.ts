import { test, expect, signIn, WORST_CAPTURE } from "./fixtures";

// XKG-111: the result shows how long the capture took, the tokens it used and the model.

async function capture(page: import("@playwright/test").Page, json: unknown) {
  await signIn(page);
  await page.route("**/api/capture", (r) => r.fulfill({ json }));
  await page.goto("/");
  await page.getByLabel("Content to capture").fill("x");
  await page.getByRole("button", { name: "Capture", exact: true }).tap();
  await expect(page.getByText("Saved to GitHub ✓")).toBeVisible();
}

test("the result shows the tokens and the model", async ({ page }) => {
  await capture(page, { ...WORST_CAPTURE, usage: { model: "ft:gpt-4o-mini-2024-07-18:northwind-industries-holdings:retrieval-eval-harness:9xYzAbCd", tokensIn: 2400, tokensOut: 780 } });
  const stats = page.getByTestId("capture-stats");
  await expect(stats).toHaveText(/· 3\.2k tokens · ft:gpt-4o-mini-2024-07-18:northwind/);
  // A long fine-tune ID wraps instead of widening the page.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("a result from a server that sends no usage shows no stats line", async ({ page }) => {
  await capture(page, WORST_CAPTURE);
  await expect(page.getByTestId("capture-stats")).toHaveCount(0);
});

test("Settings tells the user which models make captures fast", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open settings" }).tap();
  await expect(page.getByRole("dialog").getByText("Captures are fastest on a small model. Reasoning models can take 30 seconds or more.")).toBeVisible();
});

test("a short model name stays in one piece on a narrow phone", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await capture(page, { ...WORST_CAPTURE, usage: { model: "gpt-6.1-terra", tokensIn: 2400, tokensOut: 1817 } });
  const model = page.getByTestId("capture-stats").getByText("gpt-6.1-terra", { exact: true });
  const lines = await model.evaluate((el) => el.getClientRects().length);
  expect(lines).toBe(1);
});
