/**
 * When the model finds no core idea, nothing is saved (XKG-116).
 *
 * The model returns `coreIdea: null` when its input holds no clear idea,
 * most often because the page couldn't be read (a bot check, a sign-in wall,
 * a page that needs JavaScript) and the model saw only the link. Saving that
 * as a placeholder capture told the user "Added to your knowledge" for an
 * empty file. Instead, extraction throws NoCoreIdeaError and each caller
 * says why in one plain sentence, with what to do next.
 */

import type { FetchFailure } from "./fetch-source";

export class NoCoreIdeaError extends Error {
  constructor() {
    super("The model found no core idea in the input.");
    this.name = "NoCoreIdeaError";
  }
}

const WHY: Record<FetchFailure, string> = {
  "bot-check": "This site blocks automated readers, so xkg couldn't read the page.",
  refused: "The site wouldn't let xkg read this page. It may need you to sign in.",
  "not-found": "xkg couldn't find this page. Check the link.",
  "not-a-page": "This link isn't a web page xkg can read, like a PDF or a file.",
  "too-short": "xkg found almost no text on this page. It may need sign-in or JavaScript to show its content.",
  unreachable: "xkg couldn't reach this page.",
};

/**
 * The web message. `failure` is why the page couldn't be read, or null when
 * it was read (or the input was pasted text).
 */
export function noCoreIdeaMessage({ isUrl, failure }: { isUrl: boolean; failure: FetchFailure | null }): string {
  if (!isUrl) return "xkg found no clear idea in this text. Nothing was saved. Add more of the text and try again.";
  const why = failure ? WHY[failure] : "xkg read the page but found no clear idea in it.";
  return `${why} Nothing was saved. Paste the page's text instead.`;
}

/** The MCP message: the capture tool doesn't open links, so an agent must send the text. */
export function noCoreIdeaAgentMessage(isUrl: boolean): string {
  return isUrl
    ? "xkg got only a link and doesn't open links from here, so it found no core idea. Nothing was saved. Read the page and call capture again with its text."
    : "xkg found no core idea in this text. Nothing was saved. Call capture again with more of the text.";
}
