import { test, expect, signIn, WORST_REPO, openSettings as openSettingsPanel } from "./fixtures";

// M1b (XKG-46): Settings → Code repos lists the repos xkg matches captures to,
// adds one from GitHub (file names only) and removes one.

const LOCAL = { repo: "acme/widgets", source: "local", files: 412, truncated: false, syncedAt: "2026-10-29T10:00:00.000Z" };
const GITHUB = { repo: WORST_REPO, source: "github", files: 3000, truncated: true, syncedAt: "2026-10-20T10:00:00.000Z" };

async function openSettings(page: import("@playwright/test").Page) {
  await page.goto("/");
  await openSettingsPanel(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog.getByRole("region", { name: "Code repos" });
}

test("lists each repo with where its map came from", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/code-repos", (r) => r.fulfill({ json: { repos: [LOCAL, GITHUB] } }));
  const section = await openSettings(page);
  await expect(section.getByText("acme/widgets", { exact: true })).toBeVisible();
  await expect(section.getByText("Your machine · synced Oct 29", { exact: true })).toBeVisible();
  await expect(section.getByText(WORST_REPO, { exact: true })).toBeVisible();
  await expect(section.getByText("GitHub, names only · synced Oct 20", { exact: true })).toBeVisible();

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test("says how to add a repo when there are none", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/code-repos", (r) => r.fulfill({ json: { repos: [] } }));
  const section = await openSettings(page);
  await expect(section.getByText("No code repos yet. Commit in a repo with the xkg git hook, or add one from GitHub below.")).toBeVisible();
});

test("adds a repo from GitHub", async ({ page }) => {
  await signIn(page);
  let posted: unknown = null;
  await page.route("**/api/code-repos", async (r) => {
    if (r.request().method() === "POST") {
      posted = r.request().postDataJSON();
      return r.fulfill({ json: { repos: [{ ...LOCAL, repo: "acme/shop", source: "github" }, LOCAL] } });
    }
    return r.fulfill({ json: { repos: [LOCAL] } });
  });
  const section = await openSettings(page);
  await section.getByLabel("Add a repo from GitHub").fill("acme/shop");
  await section.getByRole("button", { name: "Add", exact: true }).tap();
  await expect(section.getByText("acme/shop", { exact: true })).toBeVisible();
  await expect(section.getByText("GitHub, names only · synced Oct 29", { exact: true })).toBeVisible();
  expect(posted).toEqual({ repo: "acme/shop" });
  await expect(section.getByLabel("Add a repo from GitHub")).toHaveValue("");
});

test("shows why a repo couldn't be added and keeps what was typed", async ({ page }) => {
  await signIn(page);
  const error = "xkg can't read acme/secret with your GitHub sign-in. Check the name, and that your account can open it.";
  await page.route("**/api/code-repos", (r) =>
    r.request().method() === "POST" ? r.fulfill({ status: 400, json: { error } }) : r.fulfill({ json: { repos: [] } }));
  const section = await openSettings(page);
  await section.getByLabel("Add a repo from GitHub").fill("acme/secret");
  await section.getByRole("button", { name: "Add", exact: true }).tap();
  await expect(section.getByRole("alert")).toHaveText(error);
  await expect(section.getByLabel("Add a repo from GitHub")).toHaveValue("acme/secret");
});

test("removes a repo", async ({ page }) => {
  await signIn(page);
  let deleted: unknown = null;
  await page.route("**/api/code-repos", (r) => {
    if (r.request().method() === "DELETE") {
      deleted = r.request().postDataJSON();
      return r.fulfill({ json: { repos: [GITHUB] } });
    }
    return r.fulfill({ json: { repos: [LOCAL, GITHUB] } });
  });
  const section = await openSettings(page);
  await section.getByRole("button", { name: "Remove acme/widgets" }).tap();
  await expect(section.getByText("acme/widgets", { exact: true })).toHaveCount(0);
  expect(deleted).toEqual({ repo: "acme/widgets" });
});

test("says so when the list can't load", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/code-repos", (r) => r.fulfill({ status: 500, body: "down" }));
  const section = await openSettings(page);
  await expect(section.getByRole("alert")).toHaveText("Couldn't load your code repos. Try again in a moment.");
});
