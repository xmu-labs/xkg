import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { approveCliLogin, denyCliLogin, getPendingCliLogin, normalizeUserCode } from "@/lib/cli-login";
import { env } from "@/lib/env";
import { escapeHtml, PAGE_STYLE, THEME_BOOT } from "@/lib/plain-page";

// Browser sign-in for the CLI, step 2 (see lib/cli-login): the signed-in user
// checks the code against their terminal and approves the machine.
//   GET  — sign in if needed, then show "Connect <machine>?"
//   POST — the form target; approve or deny.

/** The cookie the GitHub callback reads to come back here after sign-in. */
const RETURN_COOKIE = "xkg_oauth_return";

function page(title: string, body: string, status = 200): NextResponse {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>xkg — ${escapeHtml(title)}</title>${THEME_BOOT}<style>${PAGE_STYLE}</style></head><body><div style="max-width:24rem;width:100%;background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:28px;">
<img src="/brand/xkg-2d-light.svg" alt="xkg" width="96" height="46" class="logo logo-light" /><img src="/brand/xkg-2d-dark.svg" alt="" width="96" height="46" class="logo logo-dark" />
<h1 style="font-size:1.15rem;margin:0 0 8px;">${escapeHtml(title)}</h1>${body}</div></body></html>`;
  return new NextResponse(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

const p = (text: string) => `<p style="opacity:0.8;line-height:1.5;margin:0 0 12px;">${text}</p>`;

function expiredPage(): NextResponse {
  return page("Code not found", p("This code is wrong or expired. Run <code>xkg init</code> again in your terminal to get a new one."), 404);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const user = await getSession();
    if (!user) {
      const res = NextResponse.redirect(`${env.appUrl}/api/auth/github`);
      const back = `${env.appUrl}/api/cli-login/approve?code=${encodeURIComponent(new URL(req.url).searchParams.get("code") ?? "")}`;
      res.cookies.set(RETURN_COOKIE, back, { httpOnly: true, secure: env.isProduction, sameSite: "lax", maxAge: 600, path: "/" });
      return res;
    }
    if (!user.github_repo) {
      return page("Finish setting up xkg", p(`Your account isn't set up yet. Finish at <a href="${env.appUrl}/onboard" style="color:inherit;">${escapeHtml(env.appUrl)}/onboard</a>, then run <code>xkg init</code> again.`));
    }

    const login = await getPendingCliLogin(new URL(req.url).searchParams.get("code") ?? "");
    if (!login) return expiredPage();

    const button = (action: string, label: string, primary: boolean) =>
      `<button type="submit" name="action" value="${action}" style="flex:${primary ? 2 : 1};padding:12px;border-radius:10px;${primary ? "border:none;background:var(--btn);color:var(--btn-fg);font-weight:600;" : "border:1px solid var(--line);background:transparent;color:var(--fg);"}font-size:0.9rem;cursor:pointer;">${label}</button>`;
    return page(
      "Connect this computer?",
      p(`<strong>${escapeHtml(login.label)}</strong> wants to use your xkg account from the command line.`) +
        `<p style="opacity:0.6;line-height:1.5;font-size:0.85rem;margin:0 0 12px;">Signed in as <strong>${escapeHtml(user.github_username)}</strong>.</p>` +
        `<p style="line-height:1.4;font-size:0.85rem;margin:0 0 20px;padding:10px;border-radius:8px;background:var(--note);border:1px solid var(--line);">Your terminal shows <strong style="font-family:ui-monospace,monospace;font-size:1rem;">${escapeHtml(login.userCode)}</strong>. Only approve if it does and you just ran <code style="white-space:nowrap;">xkg init</code>.</p>` +
        `<form method="POST" action="/api/cli-login/approve"><input type="hidden" name="code" value="${escapeHtml(login.userCode)}"><div style="display:flex;gap:10px;">${button("deny", "Deny", false)}${button("approve", "Approve", true)}</div></form>`,
    );
  } catch (err) {
    console.error("[cli-login/approve]", err);
    return page("Something went wrong", p("Please try again."), 500);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // A form on another site must not approve a login with this user's cookie.
    const site = req.headers.get("sec-fetch-site");
    if (site && site !== "same-origin") return page("Not allowed", p("Approve from the xkg page itself."), 403);

    const user = await getSession();
    if (!user) return page("Signed out", p("Your session expired. Open the link from your terminal again."), 401);

    const form = await req.formData();
    const code = normalizeUserCode(String(form.get("code") ?? ""));
    if (!code) return expiredPage();

    // Default to denial: only an explicit approval adds a key.
    if (form.get("action") !== "approve") {
      await denyCliLogin(code);
      return page("Denied", p("This computer was not connected. You can close this tab."));
    }
    if (!(await approveCliLogin(code, user.id))) {
      return page("Code expired", p("This code was already used or expired. Run <code>xkg init</code> again in your terminal."), 410);
    }
    return page("Connected", p("This computer can now use xkg. Go back to your terminal; you can close this tab."));
  } catch (err) {
    console.error("[cli-login/approve]", err);
    return page("Something went wrong", p("Please try again."), 500);
  }
}
