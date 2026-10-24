import { defineConfig, devices } from "@playwright/test";
import { selectsUiProject } from "./tests/support/selects-ui";

/**
 * Two projects:
 *
 *  - "network": live-network integration tests for the capture URL-fetch
 *    feature (`tests/e2e`). They exercise `fetchSourceContent` against real
 *    URLs and use no browser.
 *  - "ui": the web app in a phone-sized Chromium (`tests/ui`). It runs against
 *    a production build (`npm run build` first) with every `/api/*` call
 *    mocked at the browser, so no database or LLM is needed. These are the
 *    tests that see computed CSS and layout: overflow at 320 px, input font
 *    sizes, touch behaviour, history.
 *
 * Unit tests for the pure helpers live next to the source and run under
 * vitest (`npm test`). vitest only globs `*.test.ts`, so it ignores these
 * `*.spec.ts` files; the runners do not overlap.
 */
const UI_PORT = 3100;

export default defineConfig({
  timeout: 30_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"]],
  projects: [
    {
      name: "network",
      testDir: "./tests/e2e",
      testMatch: "**/*.spec.ts",
    },
    {
      name: "ui",
      testDir: "./tests/ui",
      testMatch: "**/*.spec.ts",
      // Small Android phone: the narrowest width people still browse at.
      use: {
        ...devices["Pixel 7"],
        viewport: { width: 320, height: 720 },
        baseURL: `http://localhost:${UI_PORT}`,
        // A preinstalled Chromium of another version can stand in locally.
        launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
      },
    },
  ],
  webServer: selectsUiProject(process.argv)
    ? {
        command: `npx next start -p ${UI_PORT}`,
        url: `http://localhost:${UI_PORT}/login`,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      }
    : undefined,
});
