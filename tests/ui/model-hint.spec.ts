import { test, expect, signIn, WORST_CAPTURE, WORST_ME, openSettings } from "./fixtures";
import type { Page, Request } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { ModelSpeedRow } from "../../src/lib/model-speed";

const MODEL_SPEED = JSON.parse(readFileSync("src/lib/model-speed.json", "utf8")) as ModelSpeedRow[];

// XKG-120: show only what helps. A fast capture shows nothing extra. A slow one
// offers the measured fast model: Use (with Undo) or Keep mine.

const row = MODEL_SPEED.find((r) => r.provider === "openai")!;
const usual = Math.max(1, Math.round(row.fastMeanMs / 1000));
const TERRA_ME = { ...WORST_ME, llmModel: "gpt-6.1-terra", llmEffort: null };
const slowUsage = { model: "gpt-6.1-terra", tokensIn: 2400, tokensOut: 1817, extractMs: 25_000, effortApplied: false };

async function capture(page: Page, json: unknown, me: Record<string, unknown> = TERRA_ME) {
  await signIn(page, me as typeof WORST_ME);
  await page.route("**/api/capture", (r) => r.fulfill({ json }));
  await page.goto("/");
  await page.getByLabel("Content to capture").fill("x");
  await page.getByRole("button", { name: "Capture", exact: true }).tap();
  await expect(page.getByTestId("saved")).toBeVisible();
}

/** Answers PATCH /api/me like the server: the profile with the body applied. Returns the bodies sent. */
async function patchMe(page: Page, me: Record<string, unknown> = TERRA_ME, status = 200) {
  const bodies: Array<Record<string, unknown>> = [];
  await page.route("**/api/me", (r) => {
    if (r.request().method() !== "PATCH") return r.fulfill({ json: me });
    const body = (r.request() as Request).postDataJSON() as Record<string, unknown>;
    bodies.push(body);
    if (status !== 200) return r.fulfill({ status, json: { error: "[me] database unavailable" } });
    me = { ...me, ...body };
    return r.fulfill({ json: me });
  });
  return bodies;
}

test("a fast capture shows no stats line and no hint", async ({ page }) => {
  await capture(page, { ...WORST_CAPTURE, usage: { ...slowUsage, extractMs: 9_000 } });
  await expect(page.getByTestId("capture-stats")).toHaveCount(0);
  await expect(page.getByTestId("model-hint")).toHaveCount(0);
});

test("a slow capture offers the measured fast model", async ({ page }) => {
  await capture(page, { ...WORST_CAPTURE, usage: slowUsage });
  const hint = page.getByTestId("model-hint");
  await expect(hint).toContainText(`This took 25 s. ${row.fastModel} usually takes about ${usual} s.`);
  await expect(hint.getByRole("button", { name: `Use ${row.fastModel}` })).toBeVisible();
  await expect(hint.getByRole("button", { name: "Keep mine" })).toBeVisible();
});

test("Use switches the model and Undo puts it back", async ({ page }) => {
  await capture(page, { ...WORST_CAPTURE, usage: slowUsage });
  const bodies = await patchMe(page);
  const hint = page.getByTestId("model-hint");
  await hint.getByRole("button", { name: `Use ${row.fastModel}` }).tap();
  await expect(hint).toContainText(`Switched to ${row.fastModel}.`);
  expect(bodies[0]).toEqual({ llmModel: row.fastModel, llmEffort: null, modelNudgeDismissedFor: "gpt-6.1-terra/auto" });
  await hint.getByRole("button", { name: "Undo" }).tap();
  await expect(page.getByTestId("model-hint")).toHaveCount(0);
  expect(bodies[1]).toEqual({ llmModel: "gpt-6.1-terra", llmEffort: null });
});

test("Keep mine hides the hint and saves the answer", async ({ page }) => {
  await capture(page, { ...WORST_CAPTURE, usage: slowUsage });
  const bodies = await patchMe(page);
  await page.getByTestId("model-hint").getByRole("button", { name: "Keep mine" }).tap();
  await expect(page.getByTestId("model-hint")).toHaveCount(0);
  expect(bodies).toEqual([{ modelNudgeDismissedFor: "gpt-6.1-terra/auto" }]);
});

test("a kept setup gets no hint", async ({ page }) => {
  await capture(page, { ...WORST_CAPTURE, usage: slowUsage }, { ...TERRA_ME, modelNudgeDismissedFor: "gpt-6.1-terra/auto" });
  await expect(page.getByTestId("model-hint")).toHaveCount(0);
});

test("a failed switch says so and keeps the buttons", async ({ page }) => {
  await capture(page, { ...WORST_CAPTURE, usage: slowUsage });
  await patchMe(page, TERRA_ME, 500);
  const hint = page.getByTestId("model-hint");
  await hint.getByRole("button", { name: `Use ${row.fastModel}` }).tap();
  await expect(hint.getByRole("alert")).toHaveText("Couldn't switch the model. Try again, or change it in Settings → AI model.");
  await expect(hint.getByRole("button", { name: `Use ${row.fastModel}` })).toBeEnabled();
});

test("the hint fits a narrow phone with a long model ID", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await capture(page, { ...WORST_CAPTURE, usage: { ...slowUsage, model: WORST_ME.llmModel } }, { ...WORST_ME, llmEffort: null });
  await expect(page.getByTestId("model-hint")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("Settings quotes the measured time and says the model is used for everything", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  await openSettings(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(`Captures are fastest on ${row.fastModel}: about ${usual} s on our test set. Other models can take 20 seconds or more.`)).toBeVisible();
  await expect(dialog.getByText("xkg uses this model for everything it does with your key, including your coding agent's briefings.")).toBeVisible();
});
