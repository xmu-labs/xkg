import { NextRequest, NextResponse } from "next/server";
import { canonicalRedirect } from "@/lib/origin";

const PUBLIC_PATHS = [
  "/login",
  "/privacy",
  "/terms",
  // Browsers fetch the web app manifest without cookies, so gating it would
  // hand them the login page and the installed app would lose its icons.
  "/manifest.webmanifest",
  "/api/auth",
  "/api/auth/github",
  "/api/auth/callback",
  "/api/init-db",
  // Operator endpoints check the x-admin-secret header themselves.
  "/api/admin",
  "/api/mcp",
  // The CLI's code map sync; the route checks the xkg API key itself.
  "/api/code-map",
  // OAuth 2.1 for MCP remote connectors. These endpoints manage their own auth
  // (bearer tokens, PKCE, or a login redirect from the authorize page), so they
  // must not be gated by the session-cookie middleware.
  "/api/oauth",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-authorization-server",
];

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  // A browser on an older address moves to the canonical one before anything
  // else, so sign-in and the session cookie happen on a single host. 307, not
  // 308: browsers cache 308s for good, and this must stay reversible.
  const moved = canonicalRedirect(req);
  if (moved) return NextResponse.redirect(moved, 307);

  // Allow public paths. Match on a path-segment boundary rather than a bare
  // prefix, so "/login" does not also allow "/login-something".
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (isPublic) {
    return NextResponse.next();
  }

  // Check for session cookie
  const session =
    req.cookies.get("xkg_session") ??
    req.cookies.get("xmu_session") ??
    req.cookies.get("mnemos_session");
  if (!session) {
    // API routes must always return JSON — never redirect to the /login HTML page.
    // A 307 → 200 HTML login page makes client `res.json()` throw
    // "Unrecognized token '<'" / "The string did not match the expected pattern."
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const loginUrl = new URL("/login", req.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|jpg|jpeg|gif|webp|ico|mp4)).*)"],
};
