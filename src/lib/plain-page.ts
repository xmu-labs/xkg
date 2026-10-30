/** Shared pieces of the plain HTML pages that API routes render (OAuth consent, CLI sign-in). */

/** Escape text for interpolation into HTML element content. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Lunar Graphite, for the pages API routes render as plain HTML. Dark by
 * default like the app; light when the user chose it in Settings, read from
 * the same localStorage key by THEME_BOOT. The backdrop artwork matches the
 * app's entry pages (components/Backdrop).
 */
export const PAGE_STYLE = `
:root{color-scheme:dark;--bg:#11131A;--fg:#F2F1F6;--surface:#202332;--line:rgba(184,181,208,.24);--note:rgba(184,181,208,.08);--btn:#B8B5D0;--btn-fg:#11131A;--backdrop:url(/brand/backdrop-dark.webp)}
:root[data-theme="light"]{color-scheme:light;--bg:#F2F1F6;--fg:#11131A;--surface:#FFFFFF;--line:rgba(119,116,147,.32);--note:rgba(119,116,147,.10);--btn:#2A2D3B;--btn-fg:#F2F1F6;--backdrop:url(/brand/backdrop-light.webp)}
@media (orientation:portrait){:root{--backdrop:url(/brand/backdrop-dark-portrait.webp)}:root[data-theme="light"]{--backdrop:url(/brand/backdrop-light-portrait.webp)}}
body{font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg);display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}
body::before{content:"";position:fixed;inset:0;z-index:-1;background:radial-gradient(min(24rem,50vw) min(20rem,34vh) at 50% 50%,color-mix(in srgb,var(--bg) 80%,transparent) 50%,transparent),var(--backdrop) center/cover no-repeat;pointer-events:none}
h1{font-family:Sora,Inter,system-ui,sans-serif}
.logo{width:96px;height:46px;display:block;margin:0 0 16px}
.logo-light{display:none}
:root[data-theme="light"] .logo-light{display:block}
:root[data-theme="light"] .logo-dark{display:none}
`;
export const THEME_BOOT = `<script>try{if(localStorage.getItem("xkg-theme")==="light")document.documentElement.setAttribute("data-theme","light")}catch(e){}</script>`;
