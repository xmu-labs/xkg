/**
 * Which address the app is serving, and where browsers should be.
 *
 * The app moved from mnemos-capture.vercel.app to xkg.xmu.sh. Both stay live:
 * MCP connectors and CLI hooks set up against the old address keep calling it,
 * so the machine endpoints (MCP, token, registration, discovery) answer on every
 * known address and describe the address they were called on. Browsers are sent
 * to the canonical address (NEXT_PUBLIC_APP_URL), because GitHub sign-in has a
 * single callback URL and the session cookie belongs to one host.
 */

import { env } from "./env";

/** Every production address of this deployment, canonical or not. */
export const KNOWN_ORIGINS: readonly string[] = ["https://xkg.xmu.sh", "https://mnemos-capture.vercel.app"];

export function canonicalOrigin(): string {
  return new URL(env.appUrl).origin;
}

/**
 * The address a request was sent to, read from its Host headers rather than
 * `req.url`, which a server may rebuild from its own listen address. Null when
 * the headers don't form a valid origin.
 */
export function addressedOrigin(req: Request): string | null {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!host) return null;
  const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  try {
    return new URL(`${proto}://${host.split(",")[0]!.trim()}`).origin;
  } catch {
    return null;
  }
}

/**
 * The origin to put in discovery metadata for `req`. An address we don't serve
 * (a spoofed Host header, a preview deployment) gets the canonical one, so a
 * request can never make the metadata name an arbitrary host.
 */
export function requestOrigin(req: Request): string {
  const canonical = canonicalOrigin();
  const origin = addressedOrigin(req);
  return origin && (origin === canonical || KNOWN_ORIGINS.includes(origin)) ? origin : canonical;
}

/** Browser-facing API routes: sign-in and the MCP consent screen. */
const BROWSER_API_PATHS = ["/api/auth", "/api/oauth/authorize"];

function underPath(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

/**
 * Where to send a browser that reached a non-canonical known address, or null
 * to serve the request where it is.
 *
 * Only GET/HEAD to pages, sign-in and the consent screen move. The rest of
 * /api/* and /.well-known/* stay put: connectors and older CLIs call them on the
 * address they were set up with, and the OAuth code issued on the canonical
 * address is redeemed by the old address's token endpoint from the same database.
 */
export function canonicalRedirect(req: Request): URL | null {
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  const canonical = canonicalOrigin();
  const origin = addressedOrigin(req);
  if (!origin || origin === canonical || !KNOWN_ORIGINS.includes(origin)) return null;

  const url = new URL(req.url);
  const { pathname } = url;
  const isApi = underPath(pathname, "/api") || underPath(pathname, "/.well-known");
  if (isApi && !BROWSER_API_PATHS.some((p) => underPath(pathname, p))) return null;

  return new URL(`${pathname}${url.search}`, canonical);
}
