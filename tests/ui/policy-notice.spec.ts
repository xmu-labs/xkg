import { test, expect, signIn } from "./fixtures";

// XKG-62: the privacy policy promises to tell users in the app before a
// material change takes effect. The home page shows the notice once.

const notice = (page: import("@playwright/test").Page) => page.getByRole("region", { name: "Privacy update" });

// protects: AC1, a signed-in user learns about the change and can read it; fails_when: no notice, or no link to the policy; no_claim: that users read it
test("a signed-in user sees the notice with a link to the privacy page", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  await expect(notice(page)).toBeVisible();
  await expect(notice(page)).toContainText("Never your code");
  await expect(notice(page).getByRole("link", { name: "Read the privacy policy" })).toHaveAttribute("href", "/privacy");
});

// protects: AC2, the notice is shown once; fails_when: it comes back after "Got it" and a reload; no_claim: other browsers or devices
test("Got it hides the notice, and it stays hidden after a reload", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  await notice(page).getByRole("button", { name: "Got it" }).tap();
  await expect(notice(page)).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel("Content to capture")).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
});

// protects: AC3, a later change is announced too; fails_when: dismissing an older notice hides a newer one; no_claim: none
test("a notice dismissed for an older change does not hide the current one", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("xkg-policy-seen", "January 1, 2026"));
  await signIn(page);
  await page.goto("/");
  await expect(notice(page)).toBeVisible();
});

// protects: AC4, blocked storage never breaks the page; fails_when: the notice throws, never shows, or can't be closed; no_claim: none
test("with storage blocked, the notice still shows and Got it closes it", async ({ page }) => {
  await page.addInitScript(() => {
    const deny = () => { throw new DOMException("blocked", "SecurityError"); };
    Object.defineProperty(Storage.prototype, "getItem", { value: deny });
    Object.defineProperty(Storage.prototype, "setItem", { value: deny });
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page);
  await page.goto("/");
  await expect(notice(page)).toBeVisible();
  await notice(page).getByRole("button", { name: "Got it" }).tap();
  await expect(notice(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});
