import { test, expect, signIn, openSettings, WORST_CAPTURE, WORST_ME } from "./fixtures";

// XKG-145: an optional monthly AI budget. Set in Settings → AI model; the home
// page warns from 80% and again from 100%. A warning only.

const near = { calls: 40, tokensIn: 1, tokensOut: 1, costUsd: 4, unpricedCalls: 0 };
const over = { ...near, costUsd: 5.2 };

async function home(page: import("@playwright/test").Page, month: unknown, budgetUsd: number | null) {
  await signIn(page);
  await page.route("**/api/spend", (r) => r.fulfill({ json: { month, budgetUsd } }));
  await page.goto("/");
  return page.getByRole("region", { name: "AI budget" });
}

test("warns near the budget and links the provider's billing page", async ({ page }) => {
  const banner = await home(page, near, 5);
  await expect(banner).toContainText("You've used about $4.00 of your $5.00 AI budget this month.");
  const link = banner.getByRole("link", { name: "Open OpenAI billing" });
  await expect(link).toHaveAttribute("href", "https://platform.openai.com/settings/organization/billing/overview");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("Change budget opens Settings on the budget field", async ({ page }) => {
  const banner = await home(page, near, 5);
  await banner.getByRole("button", { name: "Change budget" }).tap();
  await expect(page.getByRole("dialog").getByLabel("Monthly budget (USD)")).toHaveValue("5");
});

test("dismissing hides it until the next level", async ({ page }) => {
  const banner = await home(page, near, 5);
  await banner.getByRole("button", { name: "Got it" }).tap();
  await expect(banner).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("region", { name: "AI budget" })).toHaveCount(0);

  await page.unroute("**/api/spend");
  await page.route("**/api/spend", (r) => r.fulfill({ json: { month: over, budgetUsd: 5 } }));
  await page.reload();
  await expect(page.getByRole("region", { name: "AI budget" })).toContainText("Captures still work");
});

test("no banner without a budget or under 80%", async ({ page }) => {
  await home(page, near, null);
  await expect(page.getByLabel("Content to capture")).toBeVisible();
  await expect(page.getByRole("region", { name: "AI budget" })).toHaveCount(0);
  await page.unroute("**/api/spend");
  await page.route("**/api/spend", (r) => r.fulfill({ json: { month: near, budgetUsd: 50 } }));
  await page.reload();
  await expect(page.getByLabel("Content to capture")).toBeVisible();
  await expect(page.getByRole("region", { name: "AI budget" })).toHaveCount(0);
});

test("sets and clears the budget in Settings", async ({ page }) => {
  await signIn(page);
  const puts: unknown[] = [];
  await page.route("**/api/spend", async (r) => {
    if (r.request().method() === "PUT") {
      const body = r.request().postDataJSON() as { budgetUsd: number | null };
      puts.push(body);
      return r.fulfill({ json: { budgetUsd: body.budgetUsd } });
    }
    return r.fulfill({ json: { month: near, budgetUsd: null } });
  });
  await page.goto("/");
  await openSettings(page);
  const field = page.getByRole("dialog").getByLabel("Monthly budget (USD)");
  await field.fill("5");
  await page.getByRole("dialog").getByRole("button", { name: "Save budget" }).tap();
  await expect(page.getByRole("dialog").getByText("Budget saved.")).toBeVisible();
  await field.fill("");
  await page.getByRole("dialog").getByRole("button", { name: "Save budget" }).tap();
  await expect(page.getByRole("dialog").getByText("Budget cleared.")).toBeVisible();
  expect(puts).toEqual([{ budgetUsd: 5 }, { budgetUsd: null }]);
});

test("shows the server's message for a bad budget", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/spend", (r) =>
    r.request().method() === "PUT"
      ? r.fulfill({ status: 400, json: { error: "Enter a monthly budget between $0.01 and $10,000, or leave it empty." } })
      : r.fulfill({ json: { month: near, budgetUsd: null } }),
  );
  await page.goto("/");
  await openSettings(page);
  await page.getByRole("dialog").getByLabel("Monthly budget (USD)").fill("0");
  await page.getByRole("dialog").getByRole("button", { name: "Save budget" }).tap();
  await expect(page.getByRole("dialog").getByRole("alert").filter({ hasText: "between $0.01" })).toBeVisible();
});

// Codex review on #187: the banner refreshes after a capture and after a budget save
test("a capture that crosses the budget shows the banner without a reload", async ({ page }) => {
  await signIn(page);
  let month = { ...near, costUsd: 1 };
  await page.route("**/api/spend", (r) => r.fulfill({ json: { month, budgetUsd: 5 } }));
  await page.route("**/api/capture", (r) => { month = near; return r.fulfill({ json: WORST_CAPTURE }); });
  await page.goto("/");
  await expect(page.getByLabel("Content to capture")).toBeVisible();
  await expect(page.getByRole("region", { name: "AI budget" })).toHaveCount(0);
  await page.getByLabel("Content to capture").fill("x");
  await page.getByRole("button", { name: "Capture", exact: true }).tap();
  await expect(page.getByRole("region", { name: "AI budget" })).toContainText("$4.00 of your $5.00");
});

test("raising the budget in Settings clears the banner", async ({ page }) => {
  await signIn(page);
  let budgetUsd = 5;
  await page.route("**/api/spend", async (r) => {
    if (r.request().method() === "PUT") {
      budgetUsd = (r.request().postDataJSON() as { budgetUsd: number }).budgetUsd;
      return r.fulfill({ json: { budgetUsd } });
    }
    return r.fulfill({ json: { month: near, budgetUsd } });
  });
  await page.goto("/");
  await expect(page.getByRole("region", { name: "AI budget" })).toBeVisible();
  await openSettings(page);
  await page.getByRole("dialog").getByLabel("Monthly budget (USD)").fill("50");
  await page.getByRole("dialog").getByRole("button", { name: "Save budget" }).tap();
  await expect(page.getByRole("dialog").getByText("Budget saved.")).toBeVisible();
  await expect(page.getByRole("region", { name: "AI budget" })).toHaveCount(0);
});

test("a dismissal by another account on this browser doesn't hide the warning", async ({ page }) => {
  await page.addInitScript(() => {
    const month = new Date().toISOString().slice(0, 7);
    localStorage.setItem(`xkg-budget-alert:${month}:near`, "1");
    localStorage.setItem(`xkg-budget-alert:someone-else:${month}:near`, "1");
  });
  const banner = await home(page, near, 5);
  await expect(banner).toBeVisible();
  expect(WORST_ME.githubUsername).not.toBe("someone-else");
});
