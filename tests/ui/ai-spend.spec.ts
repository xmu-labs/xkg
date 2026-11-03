import { test, expect, signIn, openSettings } from "./fixtures";

// XKG-144: Settings → AI model says what xkg spent with the user's key this month.

async function aiModel(page: import("@playwright/test").Page, month: unknown) {
  await signIn(page);
  await page.route("**/api/spend", (r) => r.fulfill({ json: { month } }));
  await page.goto("/");
  await openSettings(page);
  return page.getByRole("dialog").getByTestId("ai-spend");
}

test("shows this month's calls and estimated spend", async ({ page }) => {
  const line = await aiModel(page, { calls: 23, tokensIn: 120000, tokensOut: 30000, costUsd: 0.41, unpricedCalls: 0 });
  await expect(line).toContainText("This month: 23 calls with your key, about $0.41.");
  await expect(line).toContainText("Estimate from list prices");
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test("shows nothing when spend can't be loaded", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/spend", (r) => r.fulfill({ status: 500, json: { error: "x" } }));
  await page.goto("/");
  await openSettings(page);
  await expect(page.getByRole("dialog").getByText("AI model", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog").getByTestId("ai-spend")).toHaveCount(0);
});
