import { test, expect, signIn, WORST_CAPTURE } from "./fixtures";

// XKG-43: the capture card says where the capture applies in the user's code.

async function capture(page: import("@playwright/test").Page, json: unknown) {
  await signIn(page);
  await page.route("**/api/capture", (r) => r.fulfill({ json }));
  await page.goto("/");
  await page.getByLabel("Content to capture").fill("x");
  await page.getByRole("button", { name: "Capture", exact: true }).tap();
  await expect(page.getByText("Saved to GitHub ✓")).toBeVisible();
}

test("the card shows the fit, the repo, each file with its reason, and also-fits repos", async ({ page }) => {
  await capture(page, WORST_CAPTURE);
  const block = page.getByTestId("where");
  await expect(block.getByText("In your code", { exact: true })).toBeVisible();
  await expect(block.getByText("Strong fit", { exact: true })).toBeVisible();
  for (const f of WORST_CAPTURE.where.files) await expect(block.getByText(f.path)).toBeVisible();
  await expect(block.locator("code", { hasText: "retrievalRecallAtKEvaluatorWithSemanticChunkBoundaries" })).toBeVisible();
  await expect(block.getByText(/Also fits: .*\(Possible fit\)/)).toBeVisible();
  await expect(block.getByText(/not yet checked in your code/)).toBeVisible();
  await expect(block).not.toContainText(/\d\.\d/);
});

test("with no fit, the card shows only the reason", async ({ page }) => {
  const note = "No clear fit in your repos yet: the closest files are only a weak match.";
  await capture(page, { ...WORST_CAPTURE, where: { fit: "No clear fit", repo: null, files: [], also: [], note } });
  const block = page.getByTestId("where");
  await expect(block.getByText(note)).toBeVisible();
  await expect(block.getByText("No clear fit", { exact: true })).toHaveCount(0);
});

test("an older server without where shows no block", async ({ page }) => {
  const { where: _where, ...old } = WORST_CAPTURE;
  await capture(page, old);
  await expect(page.getByTestId("where")).toHaveCount(0);
});
