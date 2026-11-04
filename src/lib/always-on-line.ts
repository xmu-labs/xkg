/**
 * The always-on line (XKG-199). Chat apps can't run the session-start hook and
 * don't all read MCP server instructions, but each has a box of standing
 * instructions its AI reads in every chat. Pasting this one line there makes
 * the AI start the briefing on its own. The same text works in every app; CLI
 * agents get the equivalent line from `xkg init`.
 */

export const ALWAYS_ON_LINE =
  "When a chat or coding session starts, or when I say \"brief me\", call the xkg briefing tool (in a coding session, with the repo you're in) and tell me in one line what's waiting before we start.";

/** Where each chat app keeps its standing instructions. */
export const ALWAYS_ON_APPS: Array<{ app: string; where: string }> = [
  { app: "ChatGPT", where: "Settings → Personalization → Custom instructions" },
  { app: "Grok", where: "Settings → Customize → Custom instructions" },
  { app: "Claude", where: "Settings → Profile → personal preferences" },
  { app: "Gemini", where: "Settings → Saved info" },
];
