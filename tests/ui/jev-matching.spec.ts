import { test, expect, signIn, openSettings, WORST_ME } from "./fixtures";

// Settings → AI model → Where it applies: the user chooses whether TypeSafe's
// Jev or their own model decides where a capture applies.

const WITH_JEV = { ...WORST_ME, jevAvailable: true, jevMatching: true };

test("switches Where it applies to the user's model and saves it", async ({ page }) => {
  await signIn(page, WITH_JEV as typeof WORST_ME);
  let patched: unknown = null;
  await page.route("**/api/me", async (r) => {
    if (r.request().method() === "PATCH") {
      patched = r.request().postDataJSON();
      return r.fulfill({ json: { ...WITH_JEV, jevMatching: false } });
    }
    return r.fulfill({ json: WITH_JEV });
  });
  await page.goto("/");
  await openSettings(page);
  const dialog = page.getByRole("dialog");
  const group = dialog.getByRole("group", { name: "Where it applies" });
  await expect(group.getByRole("button", { name: "Jev (TypeSafe)" })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByText("TypeSafe's Jev picks the files")).toBeVisible();

  await group.getByRole("button", { name: "Your model" }).tap();
  await expect(dialog.getByText("Nothing goes to TypeSafe.")).toBeVisible();
  await dialog.getByRole("button", { name: "Save AI settings" }).tap();
  await expect(dialog.getByRole("button", { name: "Saved" })).toBeVisible();
  expect(patched).toMatchObject({ jevMatching: false });

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test("hides the choice when the server can't call Jev", async ({ page }) => {
  await signIn(page, { ...WORST_ME, jevAvailable: false } as typeof WORST_ME);
  await page.goto("/");
  await openSettings(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("AI model", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("group", { name: "Where it applies" })).toHaveCount(0);
});
