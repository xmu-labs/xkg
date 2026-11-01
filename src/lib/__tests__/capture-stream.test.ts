import { describe, it, expect } from "vitest";
import { readCaptureResponse, CAPTURE_DROPPED_WHILE_SAVING, type CaptureStage } from "../capture-stream";

/**
 * The page reads the capture answer as newline-delimited JSON: stage lines,
 * then the result or an error. Old servers and test mocks answer plain JSON,
 * which still works.
 */

const enc = new TextEncoder();
function ndjson(chunks: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(chunk));
      c.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
}

async function read(res: Response) {
  const stages: CaptureStage[] = [];
  const result = await readCaptureResponse<{ filename: string }>(res, (s) => stages.push(s));
  return { stages, result };
}

describe("readCaptureResponse", () => {
  // protects: each stage reaches the page in order, then the result; fails_when: stages are dropped or the result is lost; no_claim: none
  it("reports each stage, then returns the result", async () => {
    const res = ndjson(['{"stage":"reading"}\n{"stage":"extracting"}\n', '{"stage":"saving"}\n{"result":{"filename":"a.md"}}\n']);
    expect(await read(res)).toEqual({ stages: ["reading", "extracting", "saving"], result: { filename: "a.md" } });
  });

  // protects: a line split across network chunks is still read whole; fails_when: chunks are parsed one by one; no_claim: none
  it("joins a line split across chunks", async () => {
    const res = ndjson(['{"stage":"extr', 'acting"}\n{"result":{"file', 'name":"b.md"}}']);
    expect(await read(res)).toEqual({ stages: ["extracting"], result: { filename: "b.md" } });
  });

  // protects: a server error after the stream starts reaches the user as its message; fails_when: the error line is ignored; no_claim: none
  it("throws the error line's message", async () => {
    const res = ndjson(['{"stage":"extracting"}\n{"error":"[llm:openai] HTTP 503","status":502}\n']);
    await expect(read(res)).rejects.toThrow("[llm:openai] HTTP 503");
  });

  // protects: a connection lost while saving tells the user to check before retrying; fails_when: a generic error invites a duplicate capture; no_claim: whether it saved
  it("says to check the captures when the connection drops while saving", async () => {
    const res = ndjson(['{"stage":"extracting"}\n{"stage":"saving"}\n']);
    await expect(read(res)).rejects.toThrow(CAPTURE_DROPPED_WHILE_SAVING);
  });

  // protects: a drop before saving is a plain failure; fails_when: it claims the capture may be saved; no_claim: none
  it("fails plainly when the connection drops before saving", async () => {
    const res = ndjson(['{"stage":"extracting"}\n']);
    await expect(read(res)).rejects.toThrow("Couldn't capture that. Try again in a moment.");
  });

  // protects: plain JSON answers still work (old servers, test mocks); fails_when: only the stream is accepted; no_claim: none
  it("accepts a plain JSON answer", async () => {
    const res = new Response(JSON.stringify({ filename: "c.md" }), { headers: { "content-type": "application/json" } });
    expect(await read(res)).toEqual({ stages: [], result: { filename: "c.md" } });
  });

  // protects: a JSON error with a status reaches the user; fails_when: the status is ignored; no_claim: none
  it("throws the error of a plain JSON failure", async () => {
    const res = new Response(JSON.stringify({ error: "Rate limit reached" }), { status: 429, headers: { "content-type": "application/json" } });
    await expect(read(res)).rejects.toThrow("Rate limit reached");
  });

  // protects: a non-JSON answer (an HTML error page) gives a clear message; fails_when: a parse error leaks to the user; no_claim: none
  it("explains an answer that isn't JSON", async () => {
    const res = new Response("<html>oops</html>", { status: 200, headers: { "content-type": "text/html" } });
    await expect(read(res)).rejects.toThrow("Unexpected response from server. Please refresh and try again.");
  });
});
