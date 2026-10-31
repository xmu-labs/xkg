/**
 * The capture progress stream, shared by the route (writer) and the page
 * (reader). When the page asks for it with `Accept: application/x-ndjson`,
 * POST /api/capture answers one JSON object per line:
 *
 *   {"stage":"reading"}      only when a URL's page is fetched
 *   {"stage":"extracting"}
 *   {"stage":"saving"}
 *   {"result":{...}}         or {"error":"...","status":502}
 *
 * A request rejected before any work starts (401, 400, 429) still gets a
 * plain JSON answer with its status. No server imports: the page bundles this.
 */

export type CaptureStage = "reading" | "extracting" | "saving";

export const CAPTURE_STREAM_TYPE = "application/x-ndjson";

export type CaptureLine =
  | { stage: CaptureStage }
  | { result: unknown }
  | { error: string; status: number };

export const CAPTURE_FAILED = "Couldn't capture that. Try again in a moment.";
export const CAPTURE_DROPPED_WHILE_SAVING =
  "The connection dropped while saving. Check your captures before trying again: it may have been saved.";
const NOT_JSON = "Unexpected response from server. Please refresh and try again.";

/**
 * Read a capture answer: report each stage, return the result, or throw an
 * Error whose message is for the user. Plain JSON answers (older servers)
 * work too.
 */
export async function readCaptureResponse<T>(res: Response, onStage: (stage: CaptureStage) => void): Promise<T> {
  if (!(res.headers.get("content-type") ?? "").includes(CAPTURE_STREAM_TYPE) || !res.body) {
    let data: { error?: string };
    try {
      data = (await res.json()) as { error?: string };
    } catch {
      throw new Error(res.ok ? NOT_JSON : CAPTURE_FAILED);
    }
    if (!res.ok) throw new Error(data.error || CAPTURE_FAILED);
    return data as T;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let last: CaptureStage | null = null;

  const handle = (line: string): { done: true; value: T } | null => {
    if (!line.trim()) return null;
    let parsed: CaptureLine;
    try {
      parsed = JSON.parse(line) as CaptureLine;
    } catch {
      throw new Error(NOT_JSON);
    }
    if ("stage" in parsed) {
      last = parsed.stage;
      onStage(parsed.stage);
      return null;
    }
    if ("error" in parsed) throw new Error(parsed.error || CAPTURE_FAILED);
    return { done: true, value: parsed.result as T };
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffered += decoder.decode(value, { stream: !done });
      const lines = buffered.split("\n");
      buffered = done ? "" : lines.pop()!;
      for (const line of lines) {
        const out = handle(line);
        if (out) return out.value;
      }
      if (done) break;
    }
  } catch (err) {
    // fetch reports a dropped connection as a TypeError; that reads as a drop below.
    if (!(err instanceof TypeError)) throw err;
  }
  throw new Error(last === "saving" ? CAPTURE_DROPPED_WHILE_SAVING : CAPTURE_FAILED);
}
