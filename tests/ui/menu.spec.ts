import { test, expect, signIn, openMenu, openSettings, WORST_ME, WORST_REPO, WORST_CAPTURE } from "./fixtures";

// XKG-94: one ☰ menu holds the account, the pages and Settings; the result
// says the capture was added to your knowledge.

test("the header has one menu button and no text links or avatar", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  const menu = page.getByRole("button", { name: "Menu" });
  await expect(menu).toBeVisible();
  const box = (await menu.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByRole("main").getByRole("link", { name: "Your knowledge" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open settings" })).toHaveCount(0);
});

test("the menu shows the account, the pages, Settings and where captures are stored", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  await openMenu(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Menu" })).toBeVisible();
  await expect(dialog.getByText(WORST_ME.displayName)).toBeVisible();
  await expect(dialog.getByText(`@${WORST_ME.githubUsername}`)).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Capture", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(dialog.getByRole("link", { name: /Your knowledge/ })).toHaveAttribute("href", "/knowledge");
  await expect(dialog.getByRole("button", { name: "Settings" })).toBeVisible();
  await expect(dialog.getByText(WORST_REPO)).toBeVisible();
  for (const row of [dialog.getByRole("link", { name: "Capture", exact: true }), dialog.getByRole("button", { name: "Settings" })]) {
    expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(48);
  }
});

test("Settings opens inside the menu and Back returns to it", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  await openSettings(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(dialog.getByLabel("Name")).toBeVisible();
  await dialog.getByRole("button", { name: "Back to menu" }).tap();
  await expect(dialog.getByRole("heading", { name: "Menu" })).toBeVisible();
});

test("Escape closes the menu and focus goes back to the menu button", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  await openMenu(page);
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Menu" })).toBeFocused();
});

test("the result says it was added to your knowledge, with a link to all of it", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/capture", (r) => r.fulfill({ json: WORST_CAPTURE }));
  await page.goto("/");
  await page.getByLabel("Content to capture").fill("x");
  await page.getByRole("button", { name: "Capture", exact: true }).tap();
  const saved = page.getByTestId("saved");
  await expect(saved.getByText("Added to your knowledge")).toBeVisible();
  await expect(saved.getByText("Your AI can use it now")).toBeVisible();
  await expect(saved.getByRole("link", { name: /See all/ })).toHaveAttribute("href", "/knowledge");
  await expect(page.getByText("Saved to GitHub ✓")).toHaveCount(0);
  // The save row comes before the title.
  const row = (await saved.boundingBox())!;
  const title = (await page.getByRole("heading", { level: 2 }).first().boundingBox())!;
  expect(row.y).toBeLessThan(title.y);
});

test("Your knowledge has the same menu", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/captures", (r) => r.fulfill({ json: { captures: [] } }));
  await page.route("**/api/apply-stats", (r) => r.fulfill({ json: { weeks: [] } }));
  await page.goto("/knowledge");
  await expect(page.getByRole("main").getByRole("link", { name: "Capture", exact: true })).toHaveCount(0);
  await openMenu(page);
  await expect(page.getByRole("dialog").getByText(WORST_ME.displayName)).toBeVisible();
});
