import { test as base, type Page } from "@playwright/test";

/**
 * Worst-case data a real account can produce: a long Polish name, a GitHub
 * handle at the 39-character limit, an avatar URL that 404s, and a capture
 * whose fields carry unbroken URLs and an invented content type.
 */
export const WORST_ME = {
  githubUsername: "aleksandra-wisniewska-kowalczyk-0123456",
  displayName: "Aleksandra Wiśniewska-Kowalczyk 1234",
  avatarUrl: "/does-not-exist/avatar.png",
  hasCustomAvatar: true,
  hasMcpKey: true,
  hasPin: true,
  version: "1.6.1",
};

const LONG_URL =
  "https://northwind-industries-holdings.example.com/blog/2026/10/retrieval-augmented-generation-evaluation-harness-open-source-release";

export const WORST_CAPTURE = {
  capture: {
    inferredTitle: `Why RAG pipelines fail in production ${LONG_URL}`,
    coreIdea: `Most failures come from retrieval, not generation. ${LONG_URL}`,
    takeaways: [`Measure recall@k before tuning prompts; ${LONG_URL}`, "Chunk by semantic boundary.", "Re-rank."],
    quotes: [LONG_URL],
    tags: ["retrieval-augmented-generation-evaluation-harness-open-source", "evaluation"],
    appliedTo: LONG_URL,
    inferredType: "podcast-episode-transcript",
  },
  filename: "2026-10-24-why-retrieval-augmented-generation-pipelines-fail-in-production-a-field-guide.md",
};

/** Signs the page in (the middleware only checks the cookie exists) and mocks the API. */
export async function signIn(page: Page, me = WORST_ME) {
  await page.context().addCookies([{ name: "xkg_session", value: "test", domain: "localhost", path: "/" }]);
  await page.route("**/api/me", (r) => r.fulfill({ json: me }));
  await page.route("**/api/version", (r) => r.fulfill({ json: { buildId: "test" } }));
}

export async function setTheme(page: Page, theme: "light" | "dark") {
  await page.addInitScript((t) => localStorage.setItem("xkg-theme", t), theme);
}

export const test = base;
export { expect } from "@playwright/test";
