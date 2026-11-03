import { describe, it, expect } from "vitest";
import { NoCoreIdeaError, noCoreIdeaMessage, noCoreIdeaAgentMessage } from "../empty-capture";

/**
 * XKG-116: when the model finds no core idea, nothing is saved and the user is
 * told why, in one plain sentence, with what to do next.
 */
describe("noCoreIdeaMessage (web)", () => {
  // protects: the user learns the page itself was blocked; fails_when: a bot check reads as a generic failure; no_claim: detection (fetch-source.test.ts)
  it("names a bot check and says to paste the text", () => {
    expect(noCoreIdeaMessage({ isUrl: true, failure: "bot-check" })).toBe(
      "This site blocks automated readers, so xkg couldn't read the page. Nothing was saved. Paste the page's text instead.",
    );
  });

  it("names a refused page and the likely sign-in", () => {
    expect(noCoreIdeaMessage({ isUrl: true, failure: "refused" })).toMatch(/^The site wouldn't let xkg read this page\. It may need you to sign in\. Nothing was saved\./);
  });

  it("says when the page wasn't found", () => {
    expect(noCoreIdeaMessage({ isUrl: true, failure: "not-found" })).toMatch(/^xkg couldn't find this page\. Check the link\./);
  });

  it("says when the link isn't a web page", () => {
    expect(noCoreIdeaMessage({ isUrl: true, failure: "not-a-page" })).toMatch(/isn't a web page xkg can read/);
  });

  it("says when the page had almost no text", () => {
    expect(noCoreIdeaMessage({ isUrl: true, failure: "too-short" })).toMatch(/almost no text on this page/);
  });

  it("says when the page couldn't be reached", () => {
    expect(noCoreIdeaMessage({ isUrl: true, failure: "unreachable" })).toMatch(/^xkg couldn't reach this page\./);
  });

  it("says the page was read but had no clear idea", () => {
    expect(noCoreIdeaMessage({ isUrl: true, failure: null })).toBe(
      "xkg read the page but found no clear idea in it. Nothing was saved. Paste the page's text instead.",
    );
  });

  it("asks for more text when the input was pasted text", () => {
    expect(noCoreIdeaMessage({ isUrl: false, failure: null })).toBe(
      "xkg found no clear idea in this text. Nothing was saved. Add more of the text and try again.",
    );
  });
});

describe("noCoreIdeaAgentMessage (MCP)", () => {
  // protects: an agent that sent a bare link knows to send the page's text; fails_when: the agent gets no next step; no_claim: none
  it("tells an agent that sent a link to send the page's text", () => {
    expect(noCoreIdeaAgentMessage(true)).toBe(
      "xkg got only a link and doesn't open links from here, so it found no core idea. Nothing was saved. Read the page and call capture again with its text.",
    );
  });

  it("tells an agent that sent text to send more of it", () => {
    expect(noCoreIdeaAgentMessage(false)).toBe(
      "xkg found no core idea in this text. Nothing was saved. Call capture again with more of the text.",
    );
  });
});

describe("NoCoreIdeaError", () => {
  it("is an Error with its own name, so callers can tell it from provider errors", () => {
    const err = new NoCoreIdeaError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("NoCoreIdeaError");
  });
});
