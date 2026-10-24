import { test, expect, signIn, setTheme, WORST_CAPTURE } from "./fixtures";

// M1 (XKG-9): the platform floor on a 320 px touch phone.

test("a capture full of long URLs never scrolls the page sideways", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/capture", (r) => r.fulfill({ json: WORST_CAPTURE }));
  await page.goto("/");
  await page.getByLabel("Content to capture").fill("x");
  await page.getByRole("button", { name: "Capture", exact: true }).tap();
  await expect(page.getByText("Saved to GitHub ✓")).toBeVisible();

  // Compare with the device width, not innerWidth: a mobile browser widens
  // the layout viewport to fit overflowing content, which hides the bug.
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test("every text field is at least 16px, so iOS never zooms on focus", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open settings" }).tap();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Change PIN" }).tap();

  const sizes = await page.locator("input:not([type=file]), textarea").evaluateAll((els) =>
    els.map((el) => ({ name: el.getAttribute("placeholder") ?? el.getAttribute("aria-label") ?? el.outerHTML.slice(0, 60), px: parseFloat(getComputedStyle(el).fontSize) })),
  );
  expect(sizes.length).toBeGreaterThan(3);
  for (const s of sizes) expect(s.px, s.name).toBeGreaterThanOrEqual(16);
});

test("an avatar that fails to load falls back to the placeholder, not a broken image", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open settings" }).tap();
  await expect(page.getByRole("dialog")).toBeVisible();

  const broken = await page.locator("img").evaluateAll((imgs) =>
    imgs.filter((img) => {
      const i = img as HTMLImageElement;
      return i.complete && i.naturalWidth === 0 && i.getClientRects().length > 0 && getComputedStyle(i).display !== "none";
    }).map((i) => (i as HTMLImageElement).src),
  );
  expect(broken).toEqual([]);
});

for (const theme of ["light", "dark"] as const) {
  test(`native controls and tap feedback follow the ${theme} theme`, async ({ page }) => {
    await setTheme(page, theme);
    await signIn(page);
    await page.goto("/");
    const html = await page.evaluate(() => {
      const s = getComputedStyle(document.documentElement);
      return { scheme: s.colorScheme, tap: s.getPropertyValue("-webkit-tap-highlight-color") };
    });
    expect(html.scheme).toBe(theme);
    expect(html.tap).toBe("rgba(0, 0, 0, 0)");
  });
}

test("tapping Capture does not leave it stuck in its hover colour", async ({ page }) => {
  await signIn(page);
  // Never answer, so the button stays on screen in its loading state.
  await page.route("**/api/capture", () => {});
  await page.goto("/");
  await page.getByLabel("Content to capture").fill("x");
  const button = page.getByRole("button", { name: "Capture", exact: true });
  await page.waitForTimeout(500); // let the fill-in from the disabled outline finish
  const rest = await button.evaluate((b) => getComputedStyle(b).backgroundColor);
  await button.tap();
  const loading = page.getByRole("button", { name: /Extracting/ });
  await expect(loading).toBeVisible();
  await page.waitForTimeout(500); // let any colour transition settle
  expect(await loading.evaluate((b) => getComputedStyle(b).backgroundColor)).toBe(rest);
});

test("the capture fields have labels and the error is announced", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/capture", (r) => r.fulfill({ status: 500, json: { error: "Model unavailable" } }));
  await page.goto("/");
  await expect(page.getByLabel("Title")).toBeVisible();
  await page.getByLabel("Content to capture").fill("x");
  await page.getByRole("button", { name: "Capture", exact: true }).tap();
  await expect(page.locator("main").getByRole("alert")).toHaveText(/Model unavailable/);
});

test("the Android keyboard resizes the layout instead of covering it", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /interactive-widget=resizes-content/);
});

test("the Settings list keeps its scroll to itself", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open settings" }).tap();
  const scroller = page.getByRole("dialog").locator(".overflow-y-auto");
  await expect(scroller).toHaveCSS("overscroll-behavior-y", "contain");
});

test("placeholders use a real ellipsis", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  await expect(page.getByLabel("Content to capture")).toHaveAttribute("placeholder", /…$/);
});
