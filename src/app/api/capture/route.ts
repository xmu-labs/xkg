import { NextRequest, NextResponse, after } from "next/server";
import { getSession } from "@/lib/session";
import type { User } from "@/lib/db";
import { githubPut, appendToIndex, readFile } from "@/lib/github";
import { extractCapture, formatDate, buildMarkdown, buildIndexRow, detectSourceType, llmSettings, resolveLlm, type LlmUsage } from "@/lib/llm";
import { stepTimer, timingLine } from "@/lib/capture-timing";
import { CAPTURE_STREAM_TYPE, type CaptureLine, type CaptureStage } from "@/lib/capture-stream";
import { fetchSourceContent } from "@/lib/fetch-source";
import { linkCapture } from "@/lib/linking";
import { consumeQuota, refundQuota } from "@/lib/rate-limit";
import { captureFileUrl } from "@/lib/captureFileUrl";
import { matchCapture, whereCard, writeWhereSection } from "@/lib/where";
import { recordWhereEvent } from "@/lib/surface-events";
import { queueStrongFit } from "@/lib/handoffs";

/**
 * Capture touches the database, GitHub, and an LLM provider — any of which can
 * throw. An escaped exception makes Next.js answer with its HTML error page,
 * and the client's res.json() then fails with a cryptic browser-engine error
 * instead of the real reason. The handler is
 * wrapped so this route always answers with JSON, whatever fails inside it.
 *
 * This is not hypothetical: adding the quota check surfaced it immediately —
 * a missing usage_quota table produced an HTML 500 rather than a usable error.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    return await handleCapture(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    console.error("[capture] unhandled error:", err);
    return NextResponse.json({ error: `[capture] ${message}` }, { status: 500 });
  }
}

async function handleCapture(req: NextRequest): Promise<NextResponse> {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  if (!user.github_repo) {
    return NextResponse.json(
      { error: "Knowledge repo not configured. Complete onboarding first." },
      { status: 400 },
    );
  }

  if (!user.llm_api_key) {
    return NextResponse.json(
      { error: "API key not configured. Complete onboarding first." },
      { status: 400 },
    );
  }

  // Parse the body in its own try/catch: an unguarded req.json() throw escapes
  // the handler, Next.js answers with its HTML error page, and the client's
  // res.json() then fails with Safari's "The string did not match the expected
  // pattern." when the response is HTML. API routes must
  // always return JSON.
  let body: { content?: unknown; title?: unknown };
  try {
    body = (await req.json()) as { content?: unknown; title?: unknown };
  } catch {
    return NextResponse.json({ error: "[capture] Body must be JSON." }, { status: 400 });
  }

  const content = typeof body.content === "string" ? body.content : "";
  const title = typeof body.title === "string" ? body.title : undefined;

  if (!content.trim()) {
    return NextResponse.json({ error: "content is required" }, { status: 400 });
  }

  // Capture spends the user's own LLM credits, so cap how fast one account can
  // spend them. Without this, a stolen MCP key runs up their bill unbounded.
  // Charged after validation so malformed requests don't consume quota.
  const quota = await consumeQuota(`capture:user:${user.id}`);
  if (!quota.allowed) {
    return NextResponse.json(
      {
        error: `[capture] Rate limit reached (${quota.limit} captures/hour). Try again shortly.`,
      },
      { status: 429, headers: { "Retry-After": String(quota.resetIn) } },
    );
  }

  // Narrowed here: a closure doesn't keep the checks above.
  const ready = { ...user, github_repo: user.github_repo, llm_api_key: user.llm_api_key };

  // The links and the section are written after the answer. after() is
  // registered here, inside the request, and waits for the pipeline to hand
  // over that work (or nothing, when it fails), so a streamed answer never
  // depends on calling after() from inside the stream.
  let background: (() => Promise<void>) | null = null;
  let release!: () => void;
  const handedOver = new Promise<void>((resolve) => { release = resolve; });
  after(async () => {
    await handedOver;
    if (background) await background();
  });
  const run = async (emit: (stage: CaptureStage) => void): Promise<Outcome> => {
    try {
      return await capturePipeline({ user: ready, content, title, quotaWindow: quota.windowKey }, emit, (task) => { background = task; });
    } finally {
      release();
    }
  };

  if (!(req.headers.get("accept") ?? "").includes(CAPTURE_STREAM_TYPE)) {
    const { status, body } = await run(() => {});
    return NextResponse.json(body, { status });
  }

  // The page asked for progress: one JSON line per stage, then the result.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (line: CaptureLine) => controller.enqueue(encoder.encode(JSON.stringify(line) + "\n"));
      try {
        const { status, body } = await run((stage) => send({ stage }));
        send(status === 200 ? { result: body } : { error: (body as { error: string }).error, status });
      } catch (err) {
        console.error("[capture] unhandled error:", err);
        send({ error: `[capture] ${err instanceof Error ? err.message : "Unexpected error"}`, status: 500 });
      } finally {
        controller.close();
      }
    },
  });
  return new NextResponse(stream, {
    headers: { "Content-Type": `${CAPTURE_STREAM_TYPE}; charset=utf-8`, "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}

type Outcome = { status: number; body: unknown };

interface CaptureInput {
  /** The signed-in user, with the repo and key the checks above made sure of. */
  user: User & { github_repo: string; llm_api_key: string };
  content: string;
  title: string | undefined;
  quotaWindow: string;
}

/**
 * Fetch, extract, save, index, match, queue. Reports each stage through
 * `emit` and hands the after-answer work (links, then the section) to
 * `handOver`. Throws only on an unexpected failure (GitHub, the database).
 */
async function capturePipeline(
  { user, content, title, quotaWindow }: CaptureInput,
  emit: (stage: CaptureStage) => void,
  handOver: (task: () => Promise<void>) => void,
): Promise<Outcome> {
  const sourceType = detectSourceType(content);
  const llm = llmSettings(user);
  const timer = stepTimer();
  let usage: LlmUsage | null = null;

  // For a bare URL, fetch the live page server-side so the LLM reasons over the
  // page's real content instead of guessing from training data (which risks
  // fabricated insights or a timeout-driven "Load failed"). Best-effort: on any
  // failure we fall back to URL-only mode and pass the raw URL string through.
  let llmContent = content;
  const sourceUrl = sourceType === "url" ? content.trim() : undefined;
  let fetched = false;
  if (sourceUrl) {
    emit("reading");
    const page = await fetchSourceContent(sourceUrl);
    if (page) {
      llmContent = page;
      fetched = true;
    }
  }
  timer.mark("fetch");

  // Extract insights via LLM
  emit("extracting");
  let capture;
  try {
    capture = await extractCapture(user.llm_api_key, llmContent, title, llm, { url: sourceUrl, onUsage: (u) => { usage = u; } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Extraction failed";
    // Nothing was extracted or saved, so the try doesn't count against the hour.
    try {
      await refundQuota(`capture:user:${user.id}`, quotaWindow);
    } catch {
      // The refund is a courtesy; the error above is what the user needs.
    }
    return { status: 502, body: { error: message } };
  }
  timer.mark("extract");

  // Where it applies: one more call (Jev, or the user's model when Jev can't
  // answer), started now so it runs alongside writing the file. Never throws.
  const matching = matchCapture(user, capture);

  // Build Markdown and commit to user's repo
  emit("saving");
  const date = formatDate();
  const filename = `${date}-${capture.slug}.md`;
  const path = `inbox/${filename}`;
  const markdown = buildMarkdown(date, capture, content, sourceType);

  await githubPut(user.github_token, user.github_repo, path, markdown, `capture: add ${filename}`);
  timer.mark("save");

  // Update INDEX.md
  const row = buildIndexRow(date, capture, filename, sourceType);
  await appendToIndex(user.github_token, user.github_repo, row, `capture: update index for ${filename}`);
  timer.mark("index");

  const where = await matching;
  timer.mark("match");
  const card = where ? whereCard(where) : null;
  let waitingIn: string | null = null;
  if (where) {
    await recordWhereEvent(user.id, path, where, card !== null);
    // A Strong fit waits for the next coding session in that repo.
    if (card) waitingIn = await queueStrongFit(user, path, where, date);
  }
  timer.mark("queue");
  timer.answered();

  // The user doesn't need links or the section to see the result, so they're
  // written after the answer. Both edit the capture file, so one at a time:
  // linking first, then the section.
  const { github_token: token, github_repo: repo } = user;
  const savedCapture = capture;
  // The card shows what the capture cost: the model and its token counts.
  const spent = usage as LlmUsage | null;
  handOver(async () => {
    try {
      const indexFile = await readFile(token, repo, "INDEX.md");
      if (indexFile) await linkCapture(token, repo, savedCapture, filename, "inbox", indexFile.content);
    } catch {
      // Linking is best-effort
    }
    timer.mark("link");
    if (where) await writeWhereSection(token, repo, path, where);
    timer.mark("where");
    console.info(JSON.stringify(timingLine("web", timer, llm, usage, fetched)));
  });

  return {
    status: 200,
    body: {
      capture,
      filename,
      fileUrl: captureFileUrl(user.github_repo, filename),
      ...(card ? { where: card } : {}),
      ...(waitingIn ? { handoff: { repo: waitingIn } } : {}),
      usage: { model: resolveLlm(llm).model, tokensIn: spent?.tokensIn ?? null, tokensOut: spent?.tokensOut ?? null },
    },
  };
}
