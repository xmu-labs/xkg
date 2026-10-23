import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getOauthClient, createOauthCode, deleteExpiredOauthCodes } from "@/lib/db";
import { randomAuthCode, AUTH_CODE_TTL_SECONDS, MCP_SCOPE } from "@/lib/oauth";
import { env } from "@/lib/env";
import { isHostedInstance } from "@/lib/hosted";

// OAuth 2.1 authorization endpoint.
//   GET  — validate the request, ensure the user is signed in (GitHub), show consent.
//   POST — the consent form target; issues a single-use authorization code.
//
// PKCE is mandatory: a request without a code_challenge is rejected.

const RETURN_COOKIE = "xkg_oauth_return";

interface AuthParams {
  responseType: string;
  clientId: string;
  redirectUri: string;
  state: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string;
}

function parseParams(sp: URLSearchParams): AuthParams {
  return {
    responseType: sp.get("response_type") ?? "",
    clientId: sp.get("client_id") ?? "",
    redirectUri: sp.get("redirect_uri") ?? "",
    state: sp.get("state") ?? "",
    scope: sp.get("scope") ?? MCP_SCOPE,
    codeChallenge: sp.get("code_challenge") ?? "",
    codeChallengeMethod: sp.get("code_challenge_method") ?? "",
    resource: sp.get("resource") ?? "",
  };
}

/** Escape text for interpolation into HTML element content. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Lunar Graphite, for the two pages this route renders as plain HTML. Dark by
 * default like the app; light when the user chose it in Settings, read from
 * the same localStorage key by THEME_BOOT. The backdrop artwork matches the
 * app's entry pages (components/Backdrop).
 */
const PAGE_STYLE = `
:root{color-scheme:dark;--bg:#11131A;--fg:#F2F1F6;--surface:#202332;--line:rgba(184,181,208,.24);--note:rgba(184,181,208,.08);--btn:#B8B5D0;--btn-fg:#11131A;--backdrop:url(/brand/backdrop-dark.webp)}
:root[data-theme="light"]{color-scheme:light;--bg:#F2F1F6;--fg:#11131A;--surface:#FFFFFF;--line:rgba(119,116,147,.32);--note:rgba(119,116,147,.10);--btn:#2A2D3B;--btn-fg:#F2F1F6;--backdrop:url(/brand/backdrop-light.webp)}
@media (orientation:portrait){:root{--backdrop:url(/brand/backdrop-dark-portrait.webp)}:root[data-theme="light"]{--backdrop:url(/brand/backdrop-light-portrait.webp)}}
body{font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg);display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}
body::before{content:"";position:fixed;inset:0;z-index:-1;background:var(--backdrop) center/cover no-repeat;pointer-events:none}
h1{font-family:Sora,Inter,system-ui,sans-serif}
.logo{width:96px;height:46px;display:block;margin:0 0 16px}
.logo-light{display:none}
:root[data-theme="light"] .logo-light{display:block}
:root[data-theme="light"] .logo-dark{display:none}
`;
const THEME_BOOT = `<script>try{if(localStorage.getItem("xkg-theme")==="light")document.documentElement.setAttribute("data-theme","light")}catch(e){}</script>`;

function errorPage(message: string, status = 400): NextResponse {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>xkg — authorization error</title>${THEME_BOOT}<style>${PAGE_STYLE}</style></head><body><div style="max-width:26rem;text-align:center;"><h1 style="font-size:1.1rem;">Authorization error</h1><p style="opacity:0.8;line-height:1.5;">${message}</p></div></body></html>`;
  return new NextResponse(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/** Redirect back to the client with an OAuth error (RFC 6749 §4.1.2.1). */
function redirectError(redirectUri: string, state: string, error: string, description?: string): NextResponse {
  const u = new URL(redirectUri);
  u.searchParams.set("error", error);
  if (description) u.searchParams.set("error_description", description);
  if (state) u.searchParams.set("state", state);
  return NextResponse.redirect(u.toString());
}

/**
 * Validate the client and redirect_uri. Returns an error NextResponse (rendered
 * as an HTML page, never redirected to an unverified URI) when invalid, or the
 * validated redirect_uri when valid.
 */
async function validateClient(p: AuthParams): Promise<{ redirectUri: string } | NextResponse> {
  if (!p.clientId) return errorPage("Missing client_id.");
  const client = await getOauthClient(p.clientId);
  if (!client) return errorPage("Unknown client_id. Re-register the connector and try again.");

  let registered: string[];
  try {
    registered = JSON.parse(client.redirect_uris) as string[];
  } catch {
    registered = [];
  }

  // If a redirect_uri is supplied it must exactly match a registered one.
  // If omitted and exactly one is registered, use it.
  let redirectUri = p.redirectUri;
  if (!redirectUri) {
    if (registered.length === 1) redirectUri = registered[0]!;
    else return errorPage("Missing redirect_uri.");
  }
  if (!registered.includes(redirectUri)) {
    return errorPage("redirect_uri does not match any registered URI for this client.");
  }
  return { redirectUri };
}

// This endpoint is browser-facing, so an escaped exception would render
// Next.js's error page mid-consent-flow. Wrapped to fail as our own HTML
// error page instead — JSON would be wrong for a page the user navigates to.
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    return await handleGet(req);
  } catch (err) {
    console.error("[oauth-authorize] unhandled error:", err);
    return errorPage("Something went wrong starting the authorization. Please try again.", 500);
  }
}

async function handleGet(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url);
  const p = parseParams(searchParams);

  const clientCheck = await validateClient(p);
  if (clientCheck instanceof NextResponse) return clientCheck;
  const { redirectUri } = clientCheck;

  // From here, protocol errors can be safely reported back to the client.
  if (p.responseType !== "code") {
    return redirectError(redirectUri, p.state, "unsupported_response_type", "Only response_type=code is supported.");
  }
  if (!p.codeChallenge || p.codeChallengeMethod !== "S256") {
    return redirectError(redirectUri, p.state, "invalid_request", "PKCE with code_challenge_method=S256 is required.");
  }

  // Require a signed-in xkg user. If absent, bounce through GitHub login and
  // resume this exact authorization request afterwards.
  const user = await getSession();
  if (!user) {
    const res = NextResponse.redirect(`${env.appUrl}/api/auth/github`);
    res.cookies.set(RETURN_COOKIE, req.url, {
      httpOnly: true,
      secure: env.isProduction,
      sameSite: "lax",
      maxAge: 600,
      path: "/",
    });
    return res;
  }

  // OAuth maps the token straight to the user id, so no static api_key is needed —
  // but the knowledge repo must exist or every MCP tool would fail.
  if (!user.github_repo) {
    return errorPage(
      "Your xkg account isn't fully set up yet. Finish onboarding at " +
        `${env.appUrl}/onboard, then reconnect.`,
    );
  }

  // Render a minimal consent screen. Approving POSTs back with the same params.
  const client = await getOauthClient(p.clientId);
  // Client registration is open (RFC 7591), so client_name is attacker-
  // controlled: cap it and escape it. The real anti-phishing control is showing
  // the redirect destination below — a convincing name can be registered by
  // anyone, but the origin the code is sent to cannot be faked.
  const clientName = (client?.client_name ?? "An MCP client").slice(0, 80);
  let redirectOrigin: string;
  try {
    redirectOrigin = new URL(redirectUri).origin;
  } catch {
    redirectOrigin = redirectUri;
  }
  const hidden = (name: string, value: string) =>
    `<input type="hidden" name="${name}" value="${value.replace(/"/g, "&quot;")}">`;
  // Connectors sign in here without passing the sign-in page, so the hosted
  // service's terms are shown on this screen too.
  const legal = isHostedInstance()
    ? `<p style="opacity:0.6;line-height:1.4;font-size:0.75rem;margin:16px 0 0;text-align:center;">By approving you agree to the <a href="/terms" style="color:inherit;">Terms</a> and <a href="/privacy" style="color:inherit;">Privacy Policy</a>.</p>`
    : "";

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>xkg — connect</title>${THEME_BOOT}<style>${PAGE_STYLE}</style></head><body>
<form method="POST" action="/api/oauth/authorize" style="max-width:24rem;width:100%;background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:28px;">
  <img src="/brand/xkg-2d-light.svg" alt="xkg" width="96" height="46" class="logo logo-light" /><img src="/brand/xkg-2d-dark.svg" alt="" width="96" height="46" class="logo logo-dark" />
  <h1 style="font-size:1.15rem;margin:0 0 8px;">Connect to xkg</h1>
  <p style="opacity:0.8;line-height:1.5;margin:0 0 4px;"><strong>${escapeHtml(clientName)}</strong> wants to access your knowledge hub.</p>
  <p style="opacity:0.6;line-height:1.5;font-size:0.85rem;margin:0 0 12px;">Signed in as <strong>${escapeHtml(user.github_username)}</strong>. It will be able to capture, search, and apply your captures over MCP.</p>
  <p style="opacity:0.75;line-height:1.4;font-size:0.8rem;margin:0 0 20px;padding:10px;border-radius:8px;background:var(--note);border:1px solid var(--line);">Access will be sent to <strong style="word-break:break-all;">${escapeHtml(redirectOrigin)}</strong>. Only approve if you recognize this destination.</p>
  ${hidden("response_type", p.responseType)}
  ${hidden("client_id", p.clientId)}
  ${hidden("redirect_uri", redirectUri)}
  ${hidden("state", p.state)}
  ${hidden("scope", p.scope)}
  ${hidden("code_challenge", p.codeChallenge)}
  ${hidden("code_challenge_method", p.codeChallengeMethod)}
  ${hidden("resource", p.resource)}
  <div style="display:flex;gap:10px;">
    <button type="submit" name="action" value="deny" style="flex:1;padding:12px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--fg);font-size:0.9rem;cursor:pointer;">Deny</button>
    <button type="submit" name="action" value="approve" style="flex:2;padding:12px;border-radius:10px;border:none;background:var(--btn);color:var(--btn-fg);font-weight:600;font-size:0.9rem;cursor:pointer;">Approve</button>
  </div>
  ${legal}
</form>
</body></html>`;

  return new NextResponse(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// This endpoint is browser-facing, so an escaped exception would render
// Next.js's error page mid-consent-flow. Wrapped to fail as our own HTML
// error page instead — JSON would be wrong for a page the user navigates to.
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    return await handlePost(req);
  } catch (err) {
    console.error("[oauth-authorize] unhandled error:", err);
    return errorPage("Something went wrong starting the authorization. Please try again.", 500);
  }
}

async function handlePost(req: NextRequest): Promise<NextResponse> {
  const form = await req.formData();
  const sp = new URLSearchParams();
  for (const [k, v] of form.entries()) if (typeof v === "string") sp.set(k, v);
  const p = parseParams(sp);
  // Default to denial: only an explicit approval may mint a code.
  const action = sp.get("action") ?? "deny";

  const clientCheck = await validateClient(p);
  if (clientCheck instanceof NextResponse) return clientCheck;
  const { redirectUri } = clientCheck;

  const user = await getSession();
  if (!user) return errorPage("Your session expired. Start the connection again.", 401);

  if (action === "deny") {
    return redirectError(redirectUri, p.state, "access_denied", "The user denied the request.");
  }

  if (!p.codeChallenge || p.codeChallengeMethod !== "S256") {
    return redirectError(redirectUri, p.state, "invalid_request", "PKCE with code_challenge_method=S256 is required.");
  }

  // Issue a single-use authorization code bound to this user, client, and PKCE challenge.
  const code = randomAuthCode();
  await createOauthCode({
    code,
    client_id: p.clientId,
    user_id: user.id,
    redirect_uri: redirectUri,
    code_challenge: p.codeChallenge,
    code_challenge_method: p.codeChallengeMethod,
    scope: p.scope || MCP_SCOPE,
    resource: p.resource || null,
    expires_at: new Date(Date.now() + AUTH_CODE_TTL_SECONDS * 1000),
    created_at: new Date(),
  });

  // Opportunistic cleanup; never blocks the response.
  void deleteExpiredOauthCodes().catch(() => {});

  const u = new URL(redirectUri);
  u.searchParams.set("code", code);
  if (p.state) u.searchParams.set("state", p.state);
  return NextResponse.redirect(u.toString(), { status: 303 });
}
