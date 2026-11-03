import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchSource } from "../fetch-source";

/**
 * XKG-116: a failed page read keeps its reason, so the user can be told why
 * instead of getting an empty capture.
 */
const ARTICLE = `<html><body><p>${"Alerts without a named owner get ignored. ".repeat(20)}</p></body></html>`;
const CHALLENGE = "<html><head><title>Just a moment...</title></head><body>Enable JavaScript and cookies to continue</body></html>";

function page(body: string, status = 200, type = "text/html; charset=UTF-8") {
  return new Response(body, { status, headers: { "content-type": type } });
}

describe("fetchSource", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns the page text when it can be read", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(page(ARTICLE));
    const r = await fetchSource("https://example.com/a");
    expect(r.text).toContain("named owner");
  });

  // protects: the real 2026-11-03 case (Cloudflare answers 403 with a challenge page); fails_when: it reads as a plain refusal or a generic failure; no_claim: every bot wall
  it("names a bot check served with 403", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(page(CHALLENGE, 403));
    expect(await fetchSource("https://example.com/a")).toEqual({ text: null, failure: "bot-check" });
  });

  it("names a bot check served with 200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(page(CHALLENGE));
    expect(await fetchSource("https://example.com/a")).toEqual({ text: null, failure: "bot-check" });
  });

  it("names a refusal without a bot check", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(page("Forbidden", 403));
    expect(await fetchSource("https://example.com/a")).toEqual({ text: null, failure: "refused" });
  });

  it("treats 401 as a refusal", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(page("Sign in", 401));
    expect(await fetchSource("https://example.com/a")).toEqual({ text: null, failure: "refused" });
  });

  it("names a missing page", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(page("Not found", 404));
    expect(await fetchSource("https://example.com/a")).toEqual({ text: null, failure: "not-found" });
  });

  it("treats a server error as unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(page("oops", 500));
    expect(await fetchSource("https://example.com/a")).toEqual({ text: null, failure: "unreachable" });
  });

  it("names a link that isn't a web page", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(page("%PDF-1.7", 200, "application/pdf"));
    expect(await fetchSource("https://example.com/a.pdf")).toEqual({ text: null, failure: "not-a-page" });
  });

  it("names a page with almost no text", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(page("<html><body><div id=root></div>Loading</body></html>"));
    expect(await fetchSource("https://example.com/a")).toEqual({ text: null, failure: "too-short" });
  });

  it("names a network failure as unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    expect(await fetchSource("https://example.com/a")).toEqual({ text: null, failure: "unreachable" });
  });

  it("treats a blocked host as unreachable without fetching", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await fetchSource("http://127.0.0.1/a")).toEqual({ text: null, failure: "unreachable" });
    expect(spy).not.toHaveBeenCalled();
  });
});
