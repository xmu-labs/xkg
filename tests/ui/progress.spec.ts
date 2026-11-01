import { test, expect, signIn, WORST_CAPTURE } from "./fixtures";

// XKG-110: the capture shows each stage while it runs, read from a
// newline-delimited JSON answer.

const ndjson = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

async function start(page: import("@playwright/test").Page) {
  await signIn(page);
  await page.goto("/");
  await page.getByLabel("Content to capture").fill("https://example.com/post");
}

test("asks for the progress stream and shows the result it ends with", async ({ page }) => {
  let accept = "";
  await page.route("**/api/capture", (r) => {
    accept = r.request().headers()["accept"] ?? "";
    return r.fulfill({
      contentType: "application/x-ndjson; charset=utf-8",
      body: ndjson([{ stage: "reading" }, { stage: "extracting" }, { stage: "saving" }, { result: WORST_CAPTURE }]),
    });
  });
  await start(page);
  await page.getByRole("button", { name: "Capture", exact: true }).tap();
  await expect(page.getByTestId("saved")).toBeVisible();
  expect(accept).toContain("application/x-ndjson");
});

test("shows the current stage on the button while it waits", async ({ page }) => {
  let finish!: () => void;
  const gate = new Promise<void>((r) => { finish = r; });
  await page.route("**/api/capture", async (r) => {
    await gate;
    await r.fulfill({ contentType: "application/x-ndjson", body: ndjson([{ stage: "extracting" }, { result: WORST_CAPTURE }]) });
  });
  await start(page);
  const button = page.getByRole("button", { name: /Capture|Reading|Extracting|Saving/ });
  await button.tap();
  await expect(button).toHaveText(/Extracting insights…/);
  await expect(button).toHaveAttribute("aria-busy", "true");
  finish();
  await expect(page.getByTestId("saved")).toBeVisible();
});

test("says to check the captures when the connection drops while saving", async ({ page }) => {
  await page.route("**/api/capture", (r) =>
    r.fulfill({ contentType: "application/x-ndjson", body: ndjson([{ stage: "extracting" }, { stage: "saving" }]) }));
  await start(page);
  await page.getByRole("button", { name: "Capture", exact: true }).tap();
  await expect(page.getByText(/Check your captures before trying again/)).toBeVisible();
});

test("shows the server's error line", async ({ page }) => {
  await page.route("**/api/capture", (r) =>
    r.fulfill({ contentType: "application/x-ndjson", body: ndjson([{ stage: "extracting" }, { error: "No answer from the provider after 60s.", status: 502 }]) }));
  await start(page);
  await page.getByRole("button", { name: "Capture", exact: true }).tap();
  await expect(page.getByText("No answer from the provider after 60s.")).toBeVisible();
});
