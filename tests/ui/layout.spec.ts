import { test, expect, signIn, WORST_CAPTURE, WORST_ME } from "./fixtures";

// M3 (XKG-11): one composer, a reachable Capture button, quieter Settings.

test("title and paste field are one composer surface", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  const composer = page.locator("[data-composer]");
  await expect(composer.getByLabel("Title")).toBeVisible();
  await expect(composer.getByLabel("Content to capture")).toBeVisible();
  // The fields sit borderless inside the card; only the card draws an edge.
  for (const label of ["Title", "Content to capture"]) {
    await expect(composer.getByLabel(label)).toHaveCSS("border-top-width", "0px");
  }
});

test("on a short phone screen Capture stays on screen above the fold", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 480 });
  await signIn(page);
  await page.goto("/");
  await page.getByLabel("Content to capture").fill("x");
  const box = await page.getByRole("button", { name: "Capture", exact: true }).boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(480);
});

test("an empty Capture button looks deliberately waiting, not broken", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  const button = page.getByRole("button", { name: "Capture", exact: true });
  await expect(button).toBeDisabled();
  const look = await button.evaluate((b) => {
    const s = getComputedStyle(b);
    return { opacity: parseFloat(s.opacity), border: parseFloat(s.borderTopWidth), bg: s.backgroundColor };
  });
  expect(look.opacity).toBeGreaterThanOrEqual(0.4);
  expect(look.border).toBeGreaterThanOrEqual(1);
  expect(look.bg).toBe("rgba(0, 0, 0, 0)");
});

test("an invented capture type reads as words, not a slug", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/capture", (r) => r.fulfill({ json: WORST_CAPTURE }));
  await page.goto("/");
  await page.getByLabel("Content to capture").fill("x");
  await page.getByRole("button", { name: "Capture", exact: true }).tap();
  await expect(page.getByText("Podcast episode transcript", { exact: true })).toBeVisible();
});

test("Settings shows Save name only once the name changes", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open settings" }).tap();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Save name" })).toHaveCount(0);
  await dialog.getByLabel("Name").fill("Ola");
  await expect(dialog.getByRole("button", { name: "Save name" })).toBeVisible();
});

test("the PIN fields stay folded behind one row until asked for", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open settings" }).tap();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByPlaceholder("Current PIN")).toHaveCount(0);
  const row = dialog.getByRole("button", { name: "Change PIN" });
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await row.tap();
  await expect(row).toHaveAttribute("aria-expanded", "true");
  await expect(dialog.getByPlaceholder("Current PIN")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Update PIN" })).toHaveCount(0);
  await dialog.getByPlaceholder("Current PIN").fill("123456");
  await dialog.getByPlaceholder("New PIN", { exact: true }).fill("654321");
  await dialog.getByPlaceholder("Confirm new PIN").fill("654321");
  await expect(dialog.getByRole("button", { name: "Update PIN" })).toBeVisible();
});

test("Settings saves the model and effort together, only once they change", async ({ page }) => {
  await signIn(page);
  let patched: unknown = null;
  await page.route("**/api/me", async (r) => {
    if (r.request().method() === "PATCH") {
      patched = r.request().postDataJSON();
      return r.fulfill({ json: { ...WORST_ME, llmModel: "gpt-5", llmEffort: "low" } });
    }
    return r.fulfill({ json: WORST_ME });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open settings" }).tap();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Model", { exact: true })).toHaveValue(WORST_ME.llmModel);
  await expect(dialog.getByRole("button", { name: "High" })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByRole("button", { name: "Save model" })).toHaveCount(0);

  await dialog.getByLabel("Model", { exact: true }).fill("gpt-5");
  await dialog.getByRole("button", { name: "Low" }).tap();
  await dialog.getByRole("button", { name: "Save model" }).tap();
  await expect(dialog.getByRole("button", { name: "Saved" })).toBeVisible();
  expect(patched).toEqual({ llmModel: "gpt-5", llmEffort: "low" });
});
