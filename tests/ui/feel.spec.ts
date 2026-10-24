import { test, expect, signIn, WORST_CAPTURE } from "./fixtures";

// M2 (XKG-10): motion and the Android back gesture.

test("the Android back gesture closes Settings and stays on the page", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open settings" }).tap();
  await expect(page.getByRole("dialog")).toBeVisible();

  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe("/");
});

test("closing Settings with × takes its history entry with it, once", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  const before = await page.evaluate(() => history.length);
  await page.getByRole("button", { name: "Open settings" }).tap();
  await page.getByRole("button", { name: "Close settings" }).tap();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Reopening still works, so the first close didn't leave a stale entry.
  await page.getByRole("button", { name: "Open settings" }).tap();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe("/");
  expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(before + 1);
});

test("Settings opens on the sheet curve and closes faster than it opens", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open settings" }).tap();
  const panel = page.getByRole("dialog");
  await expect(panel).toBeVisible();
  const open = await panel.evaluate((el) => {
    const s = getComputedStyle(el);
    return { duration: s.transitionDuration, easing: s.transitionTimingFunction };
  });
  expect(open).toEqual({ duration: "0.28s", easing: "cubic-bezier(0.32, 0.72, 0, 1)" });

  await page.getByRole("button", { name: "Close settings" }).tap();
  // The panel stays mounted for the whole slide-out, then goes.
  await page.waitForTimeout(120);
  await expect(panel).toHaveCount(1);
  expect(await panel.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0.2s");
  await expect(panel).toHaveCount(0);
});

test("result cards rise in one after another", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/capture", (r) => r.fulfill({ json: WORST_CAPTURE }));
  await page.goto("/");
  await page.getByLabel("Content to capture").fill("x");
  await page.getByRole("button", { name: "Capture", exact: true }).tap();
  await expect(page.getByText("Saved")).toBeVisible();

  const cards = await page.locator("[data-reveal]").evaluateAll((els) =>
    els.map((el) => ({ name: getComputedStyle(el).animationName, delay: parseFloat(getComputedStyle(el).animationDelay) })),
  );
  expect(cards.length).toBeGreaterThanOrEqual(4);
  for (const c of cards) expect(c.name).toBe("xkg-rise");
  for (let i = 1; i < cards.length; i++) expect(cards[i]!.delay).toBeGreaterThan(cards[i - 1]!.delay);
});

test("with reduced motion the cards fade without moving", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signIn(page);
  await page.route("**/api/capture", (r) => r.fulfill({ json: WORST_CAPTURE }));
  await page.goto("/");
  await page.getByLabel("Content to capture").fill("x");
  await page.getByRole("button", { name: "Capture", exact: true }).tap();
  await expect(page.getByText("Saved")).toBeVisible();
  const names = await page.locator("[data-reveal]").evaluateAll((els) => els.map((el) => getComputedStyle(el).animationName));
  expect(new Set(names)).toEqual(new Set(["xkg-fade"]));
});

test("the Capture button keeps its size while it works", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/capture", () => {});
  await page.goto("/");
  await page.getByLabel("Content to capture").fill("x");
  const button = page.getByRole("button", { name: "Capture", exact: true });
  const before = await button.boundingBox();
  await button.tap();
  const loading = page.getByRole("button", { name: /Extracting/ });
  await expect(loading).toBeVisible();
  const after = await loading.boundingBox();
  expect(after).toEqual(before);
});

test("the Capture label crossfades into its loading text", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/capture", () => {});
  await page.goto("/");
  await page.getByLabel("Content to capture").fill("x");
  await page.getByRole("button", { name: "Capture", exact: true }).tap();
  const label = page.getByRole("button", { name: /Extracting/ }).locator("[data-label]");
  await expect(label).toHaveCSS("animation-name", "xkg-label-in");
});

test("Saved pops in from slightly smaller", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/capture", (r) => r.fulfill({ json: WORST_CAPTURE }));
  await page.goto("/");
  await page.getByLabel("Content to capture").fill("x");
  await page.getByRole("button", { name: "Capture", exact: true }).tap();
  await expect(page.getByText("Saved")).toHaveCSS("animation-name", "xkg-pop");
});
