import { test, expect, signIn, WORST_CAPTURE, WORST_REPO } from "./fixtures";

// The capture card hands a capture off to the user's coding agent: a Strong
// fit is already waiting, anything else waits after one tap, in the repo the
// user picks.

const ALSO = WORST_CAPTURE.where.also[0]!.repo;
const possible = { ...WORST_CAPTURE, where: { ...WORST_CAPTURE.where, fit: "Possible fit" } };

async function capture(page: import("@playwright/test").Page, json: unknown) {
  await signIn(page);
  await page.route("**/api/capture", (r) => r.fulfill({ json }));
  await page.goto("/");
  await page.getByLabel("Content to capture").fill("x");
  await page.getByRole("button", { name: "Capture", exact: true }).tap();
  await expect(page.getByText("Added to your knowledge")).toBeVisible();
}

test("a Strong fit queued at capture shows that it's waiting", async ({ page }) => {
  await capture(page, { ...WORST_CAPTURE, handoff: { repo: WORST_REPO } });
  const block = page.getByTestId("apply-it");
  await expect(block.getByText(`Waiting for your next session in ${WORST_REPO}`)).toBeVisible();
  await expect(block.getByRole("button", { name: "Hand off to your coding agent" })).toHaveCount(0);
});

test("one tap hands a Possible fit off to the repo shown", async ({ page }) => {
  await capture(page, possible);
  const sent: unknown[] = [];
  await page.route("**/api/handoffs", async (r) => {
    sent.push(r.request().postDataJSON());
    await r.fulfill({ json: { ok: true, status: "pending", repo: WORST_REPO } });
  });
  const block = page.getByTestId("apply-it");
  await block.getByRole("button", { name: "Hand off to your coding agent" }).tap();
  await expect(block.getByText(`Waiting for your next session in ${WORST_REPO}`)).toBeVisible();
  expect(sent).toEqual([{ filename: `inbox/${WORST_CAPTURE.filename}`, repo: WORST_REPO }]);
});

test("the repo switcher hands it off to an also-fits repo", async ({ page }) => {
  await capture(page, { ...WORST_CAPTURE, handoff: { repo: WORST_REPO } });
  const sent: unknown[] = [];
  await page.route("**/api/handoffs", async (r) => {
    sent.push(r.request().postDataJSON());
    await r.fulfill({ json: { ok: true, status: "pending", repo: ALSO } });
  });
  const block = page.getByTestId("apply-it");
  await block.getByLabel("Repo to hand off to").selectOption(ALSO);
  await block.getByRole("button", { name: "Hand off to your coding agent" }).tap();
  await expect(block.getByText(`Waiting for your next session in ${ALSO}`)).toBeVisible();
  expect(sent).toEqual([{ filename: `inbox/${WORST_CAPTURE.filename}`, repo: ALSO }]);
  await block.getByLabel("Repo to hand off to").selectOption(WORST_REPO);
  await expect(block.getByText(`Waiting for your next session in ${WORST_REPO}`)).toBeVisible();
});

test("a failed handoff says why and keeps the button", async ({ page }) => {
  await capture(page, possible);
  await page.route("**/api/handoffs", (r) => r.fulfill({ status: 502, json: { error: "Couldn't save the handoff to your knowledge repo. Try again in a moment." } }));
  const block = page.getByTestId("apply-it");
  await block.getByRole("button", { name: "Hand off to your coding agent" }).tap();
  await expect(block.getByRole("alert")).toHaveText("Couldn't save the handoff to your knowledge repo. Try again in a moment.");
  await expect(block.getByRole("button", { name: "Hand off to your coding agent" })).toBeEnabled();
});

test("no fit offers no handoff", async ({ page }) => {
  await capture(page, { ...WORST_CAPTURE, where: { fit: "No clear fit", repo: null, files: [], also: [], note: "No code repos synced yet." } });
  await expect(page.getByRole("button", { name: "Hand off to your coding agent" })).toHaveCount(0);
});
