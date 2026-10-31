import { test, expect, signIn, setTheme, WORST_CAPTURE } from "./fixtures";
import type { Page } from "@playwright/test";

// XKG-94: one "Apply it" card replaces "In your code" and "Where to use it".
// It sits right after the core idea and colors the fit.

async function capture(page: Page, json: unknown) {
  await signIn(page);
  await page.route("**/api/capture", (r) => r.fulfill({ json }));
  await page.goto("/");
  await page.getByLabel("Content to capture").fill("x");
  await page.getByRole("button", { name: "Capture", exact: true }).tap();
  await expect(page.getByText("Added to your knowledge")).toBeVisible();
}

const possible = { ...WORST_CAPTURE, where: { ...WORST_CAPTURE.where, fit: "Possible fit" } };
const noFit = {
  ...WORST_CAPTURE,
  where: { fit: "No clear fit", repo: null, files: [], also: [], note: "No clear fit in your repos yet: the closest files are only a weak match." },
};

test("a Strong fit shows the pill, the repo, each file with its reason, and also-fits repos", async ({ page }) => {
  await capture(page, WORST_CAPTURE);
  const card = page.getByTestId("apply-it");
  await expect(card.getByText("Apply it", { exact: true })).toBeVisible();
  await expect(card.getByTestId("fit")).toHaveText("Strong fit");
  await expect(card.getByText(`in ${WORST_CAPTURE.where.repo}`)).toBeVisible();
  for (const f of WORST_CAPTURE.where.files) await expect(card.getByText(f.path)).toBeVisible();
  await expect(card.locator("code", { hasText: "retrievalRecallAtKEvaluatorWithSemanticChunkBoundaries" })).toBeVisible();
  await expect(card.getByText(/Also fits: .*\(Possible fit\)/)).toBeVisible();
  await expect(card.getByText("Matched by file names. Your coding agent checks the code.")).toBeVisible();
  await expect(card).not.toContainText("not yet checked");
  await expect(card).not.toContainText("map from");
  await expect(card).not.toContainText(/\d\.\d/);
  // One card: the old blocks are gone.
  await expect(page.getByText("In your code", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Where to use it", { exact: true })).toHaveCount(0);
});

test("the card comes right after the core idea, before the takeaways", async ({ page }) => {
  await capture(page, WORST_CAPTURE);
  const y = async (name: string) => (await page.getByText(name, { exact: true }).boundingBox())!.y;
  const core = await y("Core idea");
  const apply = await y("Apply it");
  const takeaways = await y("Takeaways");
  expect(core).toBeLessThan(apply);
  expect(apply).toBeLessThan(takeaways);
});

for (const theme of ["dark", "light"] as const) {
  test(`Strong is green and Possible is amber, readable in ${theme}`, async ({ page }) => {
    await setTheme(page, theme);
    for (const [json, hue] of [[WORST_CAPTURE, "green"], [possible, "amber"]] as const) {
      await capture(page, json);
      const pill = page.getByTestId("apply-it").getByTestId("fit");
      const [fg, bg] = await pill.evaluate((el) => {
        const card = el.closest("[data-testid=apply-it]")!;
        return [getComputedStyle(el).color, getComputedStyle(card).backgroundColor];
      });
      const rgb = fg.match(/\d+/g)!.map(Number);
      if (hue === "green") expect(rgb[1]).toBeGreaterThan(Math.max(rgb[0]!, rgb[2]!));
      else expect(rgb[0]).toBeGreaterThan(rgb[2]!);
      expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
    }
  });
}

test("with no fit, the card shows only the advice", async ({ page }) => {
  await capture(page, noFit);
  const card = page.getByTestId("apply-it");
  await expect(card.getByText(WORST_CAPTURE.capture.appliedTo)).toBeVisible();
  await expect(card.getByTestId("fit")).toHaveCount(0);
  await expect(page.getByText(/No clear fit/)).toHaveCount(0);
});

test("with no fit and no advice, there is no card", async ({ page }) => {
  await capture(page, { ...noFit, capture: { ...noFit.capture, appliedTo: null } });
  await expect(page.getByTestId("apply-it")).toHaveCount(0);
});

test("an older server without where still shows the advice", async ({ page }) => {
  const { where: _where, ...old } = WORST_CAPTURE;
  await capture(page, old);
  await expect(page.getByTestId("apply-it").getByText(WORST_CAPTURE.capture.appliedTo)).toBeVisible();
  await expect(page.getByTestId("apply-it").getByTestId("fit")).toHaveCount(0);
});

test("the card has no sideways scroll at 320 px", async ({ page }) => {
  await capture(page, WORST_CAPTURE);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

function contrast(a: string, b: string): number {
  const lum = (c: string) => {
    const [r, g, bl] = c.match(/[\d.]+/g)!.slice(0, 3).map((v) => {
      const x = Number(v) / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}
