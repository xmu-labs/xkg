/**
 * Server-side source fetching for capture.
 *
 * When a user pastes a bare URL, the LLM has no internet access at inference
 * time — it can only recall from training data. That risks fabricated or stale
 * insights (garbage written into a *knowledge* repo) and slow speculative calls
 * that trip the serverless/Safari timeout as a silent "Load failed". Fetching
 * the live page on the server first lets the model reason over real extracted
 * text instead of guessing.
 *
 * Best-effort by design: any failure (timeout, non-HTML, bot challenge, blocked
 * host, too little content) returns its reason instead of text, and the caller
 * falls back to URL-only mode (passing the raw URL string to the LLM). If the
 * model then finds nothing, the reason tells the user why (XKG-116).
 */

import { MAX_INPUT_CHARS } from "./llm";

const FETCH_TIMEOUT_MS = 8000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; xkg/1.0; +https://github.com/xmu-labs/xkg)";
/** Below this, the extracted text is treated as noise (nav-only page, error wall). */
const MIN_USABLE_CHARS = 200;
/** Cap on bytes read from a response. The 8s timeout alone doesn't bound size,
 *  so a very large or slow-drip body could exhaust function memory. 5 MB is far
 *  more than any article needs (we keep only ~6k chars). */
const MAX_RESPONSE_BYTES = 5_000_000;

/** True when the entire input is a single bare URL (no surrounding prose). */
export function isBareUrl(content: string): boolean {
  return /^https?:\/\/\S+$/.test(content.trim());
}

/**
 * Block obviously-internal hosts to limit SSRF on user-supplied URLs. Covers
 * loopback, private ranges, and link-local (incl. the cloud metadata endpoint
 * 169.254.169.254) as IP literals / `localhost`.
 *
 * Redirects are re-validated hop by hop (see `safeFetch`), so a public URL that
 * 302s to an internal address is caught.
 *
 * Limitation: this does NOT resolve DNS, so a public hostname whose A record
 * points at a private IP still slips through. Closing that needs resolve-then-
 * pin-the-IP, which the platform fetch doesn't expose; it remains an accepted
 * residual risk for a tool where users paste their own public article URLs.
 */
/** The 8 16-bit groups of an IPv6 literal (no brackets), or null when it isn't one. */
function ipv6Groups(host: string): number[] | null {
  let text = host;
  const tail: number[] = [];
  const dotted = text.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const octets = dotted.slice(2, 6).map(Number);
    if (octets.some((o) => o > 255)) return null;
    tail.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
    text = dotted[1]!.endsWith("::") ? dotted[1]! : dotted[1]!.slice(0, -1);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part ? part.split(":") : []);
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  if ([...head, ...rest].some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const known = head.length + rest.length + tail.length;
  if (halves.length === 1 ? known !== 8 : known > 7) return null;
  const zeros = Array(8 - known).fill(0) as number[];
  return [...head.map((g) => parseInt(g, 16)), ...zeros, ...rest.map((g) => parseInt(g, 16)), ...tail];
}

/** The IPv4 carried by a mapped, compatible or NAT64 IPv6 literal, dotted; else null. */
function embeddedIPv4(host: string): string | null {
  const g = ipv6Groups(host);
  if (!g) return null;
  const zeroTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  const mapped = zeroTo(5) && g[5] === 0xffff;
  const compatible = zeroTo(6) && (g[6] !== 0 || g[7]! > 1); // not :: or ::1
  const nat64 = g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0);
  if (!mapped && !compatible && !nat64) return null;
  return [g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff].join(".");
}

export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets

  if (host === "localhost" || host.endsWith(".localhost")) return true;

  if (host.includes(":")) {
    // IPv6 literal (brackets already stripped)
    if (host === "::1" || host === "::") return true; // loopback / unspecified
    if (host.startsWith("fc") || host.startsWith("fd")) return true; // unique-local fc00::/7
    if (host.startsWith("fe80")) return true; // link-local
    // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64
    // (64:ff9b::a.b.c.d) addresses carry an IPv4 in their last 32 bits. Re-check
    // it so an internal address can't be smuggled through the IPv6 form. The URL
    // parser hands us hex (::ffff:a9fe:a9fe), never the dotted form, so decode it.
    const embeddedV4 = embeddedIPv4(host);
    if (embeddedV4) return isBlockedHost(embeddedV4);
    return false;
  }

  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 127 || a === 10) return true; // this-host / loopback / private
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 192 && b === 168) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
  }

  return false;
}

/**
 * Detect Cloudflare / generic bot-challenge interstitials that are served with
 * status 200 OK in place of the real article. `res.ok === true` does not mean
 * the body is usable: a challenge page can have a successful status code.
 */
export function isChallengePage(html: string): boolean {
  const h = html.toLowerCase();
  if (h.includes("cf-browser-verification") || h.includes("cf_chl_") || h.includes("cf-chl-")) {
    return true;
  }
  if (h.includes("just a moment") && h.includes("cloudflare")) return true;
  if (h.includes("enable javascript and cookies to continue")) return true;
  return false;
}

const ENTITY_MAP: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;|&apos;/gi, (m) => ENTITY_MAP[m.toLowerCase()] ?? m)
    .replace(/&#(\d+);/g, (_, n: string) => safeFromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => safeFromCodePoint(parseInt(n, 16)));
}

function safeFromCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/**
 * One HTML tag, skipping quoted attribute values whole. `<[^>]+>` ends a tag at
 * the first `>`, but attribute values may contain `>`: Wikipedia's `data-mw`
 * JSON embeds raw wikitext such as `<ref name="x">`, and cutting the tag there
 * leaked `<ref …>{{rp|…}}` debris into captures.
 *
 * Unquoted parts also stop at `<`. Without that, every unclosed `<` scanned to
 * the end of the document, which made input like `"<a ".repeat(n)` quadratic
 * (300 KB took ~30 s); now 5 MB of it takes well under a second.
 */
const TAG = /<\/?[a-z!?][^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*>/gi;

/**
 * Strip HTML down to readable text.
 *
 * Uses *separate* passes for `<script>` and `<style>` rather than one combined
 * backreference regex: embedded strings like `"</script>"` inside JavaScript
 * make a lazy combined regex stop early and leak code into the output (the bug
 * caused by parsing an HTML response as JSON).
 *
 * Closing tags match the way browsers end them: `</script foo>` closes a
 * script and `--!>` closes a comment, so neither leaks its contents.
 */
export function htmlToText(html: string): string {
  let text = html;
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script(?:[\s/][^>]*)?>/gi, " ");
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style(?:[\s/][^>]*)?>/gi, " ");
  text = text.replace(/<(nav|header|footer|aside|form|noscript|svg|iframe)\b[^>]*>[\s\S]*?<\/\1(?:[\s/][^>]*)?>/gi, " ");
  text = text.replace(/<!--[\s\S]*?--!?>/g, " ");
  text = text.replace(TAG, " "); // any remaining tags, quote-aware
  text = text.replace(/<[^<>]*>/g, " "); // malformed leftovers, e.g. an unbalanced quote
  text = decodeEntities(text);
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

/**
 * Read a response body up to `maxBytes`, then stop and cancel the stream.
 * Bounds memory against responses with no/incorrect `content-length` (the 8s
 * timeout alone doesn't cap size). A partial multi-byte char at the cut is
 * decoded leniently to the replacement char — harmless for text extraction.
 */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    total += value.length;
    if (total >= maxBytes) {
      await reader.cancel();
      break;
    }
  }

  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

/** Maximum redirects followed by `safeFetch` before giving up. */
const MAX_REDIRECTS = 5;

/**
 * Validate a URL for server-side fetching: http/https only, and not an
 * internal host. Returns the parsed URL, or null when it must not be fetched.
 */
export function validateFetchUrl(url: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (isBlockedHost(parsed.hostname)) return null;
  return parsed;
}

/**
 * Fetch with SSRF protection across redirects.
 *
 * `redirect: "follow"` would let a public URL 302 to `http://169.254.169.254`
 * and defeat the up-front host check, so redirects are handled manually and
 * every hop is re-validated with `validateFetchUrl`. Returns null when any hop
 * is disallowed, the chain is too long, or the request fails.
 */
export async function safeFetch(
  url: string,
  init: RequestInit & { method?: string } = {},
): Promise<Response | null> {
  let current = validateFetchUrl(url);
  if (!current) return null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res: Response;
    try {
      res = await fetch(current.toString(), { ...init, redirect: "manual" });
    } catch {
      return null;
    }

    // 3xx with a Location header → validate the next hop before following it.
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return res;

    const next = validateFetchUrl(new URL(location, current).toString());
    if (!next) return null;
    current = next;
  }

  return null; // too many redirects
}

/** Why a page couldn't be used, so the user can be told (XKG-116). */
export type FetchFailure = "bot-check" | "refused" | "not-found" | "not-a-page" | "too-short" | "unreachable";

export type FetchResult = { text: string } | { text: null; failure: FetchFailure };

/** Bot walls answer 403/429/503 too; only their body tells them from a plain refusal. */
const MAX_ERROR_BODY_BYTES = 200_000;

/**
 * Fetch a URL and return cleaned article text, or why it can't be used.
 * Never throws.
 */
export async function fetchSource(url: string): Promise<FetchResult> {
  const fail = (failure: FetchFailure): FetchResult => ({ text: null, failure });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await safeFetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,text/plain",
      },
    });
    if (!res) return fail("unreachable"); // blocked host, bad URL, network error, too many redirects
    if (!res.ok) {
      if ([403, 429, 503].includes(res.status)) {
        const body = await readCapped(res, MAX_ERROR_BODY_BYTES).catch(() => "");
        if (isChallengePage(body)) return fail("bot-check");
      }
      if (res.status === 401 || res.status === 403) return fail("refused");
      if (res.status === 404 || res.status === 410) return fail("not-found");
      return fail("unreachable");
    }

    const contentType = res.headers.get("content-type") ?? "";
    // Only HTML / plain text — reject text/css, text/javascript, PDFs, etc.
    if (!contentType.includes("html") && !contentType.includes("text/plain")) return fail("not-a-page");

    const declaredLength = Number(res.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) return fail("not-a-page");

    const html = await readCapped(res, MAX_RESPONSE_BYTES);
    if (isChallengePage(html)) return fail("bot-check");

    const text = htmlToText(html);
    if (text.length < MIN_USABLE_CHARS) return fail("too-short");

    // One char over the limit, so extraction can tell the page was cut.
    return { text: text.slice(0, MAX_INPUT_CHARS + 1) };
  } catch {
    return fail("unreachable"); // timeout / abort / DNS failure / network error
  } finally {
    clearTimeout(timer);
  }
}

/** The page text, or `null` when it can't be used (see fetchSource for why). */
export async function fetchSourceContent(url: string): Promise<string | null> {
  return (await fetchSource(url)).text;
}
