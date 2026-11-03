import { test, expect, signIn } from "./fixtures";

// XKG-143: a key with no credits gets a link to the provider's billing page
// under the error, and the link fits a 320 px phone.

const ERROR = "Your OpenAI key has no credits left. Add credits with OpenAI, or pick another model in Settings → AI model.";

test("a no-credits error links the provider's billing page", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/capture", (r) =>
    r.fulfill({ status: 502, json: { error: ERROR, link: { label: "Open OpenAI billing", url: "https://platform.openai.com/settings/organization/billing/overview" } } }),
  );
  await page.goto("/");
  await page.getByLabel("Content to capture").fill("x");
  await page.getByRole("button", { name: "Capture", exact: true }).tap();
  const alert = page.getByRole("alert").filter({ hasText: "no credits" });
  await expect(alert).toContainText(ERROR);
  const link = alert.getByRole("link", { name: "Open OpenAI billing" });
  await expect(link).toHaveAttribute("href", "https://platform.openai.com/settings/organization/billing/overview");
  await expect(link).toHaveAttribute("target", "_blank");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("other errors show no link", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/capture", (r) => r.fulfill({ status: 502, json: { error: "OpenAI is having trouble right now." } }));
  await page.goto("/");
  await page.getByLabel("Content to capture").fill("x");
  await page.getByRole("button", { name: "Capture", exact: true }).tap();
  const alert = page.getByRole("alert").filter({ hasText: "having trouble" });
  await expect(alert).toBeVisible();
  await expect(alert.getByRole("link")).toHaveCount(0);
});
