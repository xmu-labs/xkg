import { describe, it, expect } from "vitest";
import { isBareUrl, isBlockedHost, isChallengePage, htmlToText } from "../fetch-source";

// ── isBareUrl ─────────────────────────────────────────────────────────────────

describe("isBareUrl", () => {
  it("is true for a bare https URL", () => {
    expect(isBareUrl("https://example.com/article")).toBe(true);
  });

  it("is true for a bare http URL", () => {
    expect(isBareUrl("http://example.com")).toBe(true);
  });

  it("trims surrounding whitespace", () => {
    expect(isBareUrl("  https://example.com  ")).toBe(true);
  });

  it("is false when prose surrounds the URL", () => {
    expect(isBareUrl("see https://example.com for more")).toBe(false);
  });

  it("is false for non-URL text", () => {
    expect(isBareUrl("just a note")).toBe(false);
  });
});

// ── isBlockedHost (SSRF guard) ──────────────────────────────────────────────────

describe("isBlockedHost", () => {
  it("blocks localhost and subdomains", () => {
    expect(isBlockedHost("localhost")).toBe(true);
    expect(isBlockedHost("api.localhost")).toBe(true);
  });

  it("blocks loopback and private IPv4 ranges", () => {
    expect(isBlockedHost("127.0.0.1")).toBe(true);
    expect(isBlockedHost("10.0.0.5")).toBe(true);
    expect(isBlockedHost("192.168.1.1")).toBe(true);
    expect(isBlockedHost("172.16.0.1")).toBe(true);
    expect(isBlockedHost("172.31.255.255")).toBe(true);
  });

  it("blocks the cloud metadata / link-local range", () => {
    expect(isBlockedHost("169.254.169.254")).toBe(true);
  });

  it("blocks IPv6 loopback, unspecified, and unique-local literals", () => {
    expect(isBlockedHost("[::1]")).toBe(true);
    expect(isBlockedHost("[::]")).toBe(true);
    expect(isBlockedHost("[fc00::1]")).toBe(true);
    expect(isBlockedHost("[fe80::1]")).toBe(true);
  });

  it("blocks IPv4-mapped IPv6 that smuggles an internal address", () => {
    expect(isBlockedHost("[::ffff:127.0.0.1]")).toBe(true);
    expect(isBlockedHost("[::ffff:169.254.169.254]")).toBe(true);
    expect(isBlockedHost("[::ffff:10.0.0.1]")).toBe(true);
  });

  it("does not block IPv4-mapped IPv6 of a public address", () => {
    expect(isBlockedHost("[::ffff:8.8.8.8]")).toBe(false);
  });

  it("does not block public hostnames", () => {
    expect(isBlockedHost("example.com")).toBe(false);
    expect(isBlockedHost("blog.cloudflare.com")).toBe(false);
  });

  it("does not false-positive on hostnames that start like an IPv6 ULA", () => {
    // "fcbarcelona.com" must not be mistaken for an fc00::/7 literal.
    expect(isBlockedHost("fcbarcelona.com")).toBe(false);
    expect(isBlockedHost("fd-design.com")).toBe(false);
  });

  it("does not block public IPv4 that is outside private ranges", () => {
    expect(isBlockedHost("172.15.0.1")).toBe(false); // just below the 172.16-31 block
    expect(isBlockedHost("172.32.0.1")).toBe(false); // just above it
    expect(isBlockedHost("8.8.8.8")).toBe(false);
  });
});

// ── isChallengePage ─────────────────────────────────────────────────────────────

describe("isChallengePage", () => {
  it("detects a Cloudflare 'Just a moment' interstitial", () => {
    const html = "<html><title>Just a moment...</title><body>Checking your browser before accessing. Cloudflare</body></html>";
    expect(isChallengePage(html)).toBe(true);
  });

  it("detects cf challenge markers", () => {
    expect(isChallengePage("<div id='cf-browser-verification'></div>")).toBe(true);
    expect(isChallengePage("window.cf_chl_opt = {}")).toBe(true);
  });

  it("detects the enable-javascript-and-cookies wall", () => {
    expect(isChallengePage("Enable JavaScript and cookies to continue")).toBe(true);
  });

  it("is false for a normal article page", () => {
    expect(isChallengePage("<html><body><article>A real article about systems thinking.</article></body></html>")).toBe(false);
  });
});

// ── htmlToText ──────────────────────────────────────────────────────────────────

describe("htmlToText", () => {
  it("strips tags and collapses whitespace", () => {
    expect(htmlToText("<p>Hello   <b>world</b></p>\n<p>Again</p>")).toBe("Hello world Again");
  });

  it("removes script blocks including their JS body", () => {
    const html = `<p>Real</p><script>var s = 1; doEvil(s);</script><p>Text</p>`;
    const out = htmlToText(html);
    expect(out).toBe("Real Text");
    expect(out).not.toContain("doEvil");
  });

  it("ends script, style and comment blocks the way browsers do", () => {
    expect(htmlToText(`<script>doEvil()</script foo="bar"><p>A</p>`)).toBe("A");
    expect(htmlToText(`<style>.a{}</style\n><p>B</p>`)).toBe("B");
    expect(htmlToText(`<nav>Menu</nav x><p>C</p>`)).toBe("C");
    expect(htmlToText(`<!-- hidden --!><p>D</p>`)).toBe("D");
    // `</script-template>` is a different tag name, not a closing script tag.
    expect(htmlToText(`<script>t = "</script-template>"; track();</script><p>E</p>`)).toBe("E");
  });

  it("removes style blocks", () => {
    expect(htmlToText("<style>.a{color:red}</style><p>Body</p>")).toBe("Body");
  });

  it("removes nav, header, and footer chrome", () => {
    const html = "<nav>Home About</nav><header>Site</header><main>Content</main><footer>(c) 2026</footer>";
    expect(htmlToText(html)).toBe("Content");
  });

  it("strips HTML comments", () => {
    expect(htmlToText("<!-- hidden --><p>Shown</p>")).toBe("Shown");
  });

  it("decodes common named, decimal, and hex HTML entities", () => {
    expect(htmlToText("<p>Tom &amp; Jerry &#39;n&#39; co &#8212; &#x2764;</p>")).toBe("Tom & Jerry 'n' co — ❤");
  });

  // Wikipedia stores wikitext in data-mw JSON attributes. A raw `>` inside the
  // quoted value used to end the tag early and leak `<ref …>{{rp|…}}` debris.
  it("does not end a tag at a > inside a single-quoted attribute value", () => {
    const html =
      `<p>Before</p><sup data-mw='{"parts":[{"params":{"1":{"wt":"Unstable.&lt;ref name=\\"sepulchre\\">Royal Society</ref>{{rp|7:33}}"}}}]}'>[a]</sup><p>After</p>`;
    const out = htmlToText(html);
    expect(out).toBe("Before [a] After");
    expect(out).not.toContain("<");
    expect(out).not.toContain("{{rp");
  });

  it("does not end a tag at a > inside a double-quoted attribute value", () => {
    expect(htmlToText(`<a title="a > b" href="/x">Link</a>`)).toBe("Link");
  });

  it("keeps apostrophes and quotes in ordinary text", () => {
    expect(htmlToText(`<p>It's a "quoted" word</p><p>Don't drop this</p>`)).toBe(
      `It's a "quoted" word Don't drop this`,
    );
  });

  it("still strips a malformed tag with an unbalanced quote", () => {
    expect(htmlToText(`<p class="broken>Text</p>`)).not.toContain("<");
  });

  // Each unclosed `<` used to scan to the end of the document: ~30 s for this.
  it("stays fast on many unclosed tags", () => {
    const start = performance.now();
    htmlToText("<a ".repeat(100_000));
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
