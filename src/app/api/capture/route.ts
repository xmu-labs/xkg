import { NextRequest, NextResponse, after } from "next/server";
import { getSession } from "@/lib/session";
import { githubPut, appendToIndex, readFile } from "@/lib/github";
import { extractCapture, formatDate, buildMarkdown, buildIndexRow, detectSourceType, llmSettings, resolveLlm, type LlmUsage } from "@/lib/llm";
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
    const page = await fetchSourceContent(sourceUrl);
    if (page) {
      llmContent = page;
      fetched = true;
    }
  }
  timer.mark("fetch");

  // Extract insights via LLM
  let capture;
  try {
    capture = await extractCapture(user.llm_api_key, llmContent, title, llm, { url: sourceUrl, onUsage: (u) => { usage = u; } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Extraction failed";
    // Nothing was extracted or saved, so the try doesn't count against the hour.
    try {
      await refundQuota(`capture:user:${user.id}`, quota.windowStartedAt);
    } catch {
      // The refund is a courtesy; the error above is what the user needs.
    }
    return NextResponse.json({ error: message }, { status: 502 });
  }
  timer.mark("extract");

  // Where it applies: one more call (Jev, or the user's model when Jev can't
  // answer), started now so it runs alongside writing the file. Never throws.
  const matching = matchCapture(user, capture);

  // Build Markdown and commit to user's repo
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

  // The user doesn't need links or the section to see the result, so they're
  // written after the response. Both edit the capture file, so one at a time:
  // linking first, then the section.
  const { github_token: token, github_repo: repo, llm_api_key: apiKey } = user;
  after(async () => {
    try {
      const indexFile = await readFile(token, repo, "INDEX.md");
      if (indexFile) await linkCapture(apiKey, token, repo, capture, filename, "inbox", indexFile.content, llm);
    } catch {
      // Linking is best-effort
    }
    timer.mark("link");
    if (where) await writeWhereSection(token, repo, path, where);
    timer.mark("where");
    console.info(JSON.stringify(timingLine(timer, llm, usage, fetched)));
  });

  return NextResponse.json({
    capture,
    filename,
    fileUrl: captureFileUrl(user.github_repo, filename),
    ...(card ? { where: card } : {}),
    ...(waitingIn ? { handoff: { repo: waitingIn } } : {}),
  });
}

/** Milliseconds per step since the previous mark, plus when the response left. */
function stepTimer() {
  const start = Date.now();
  let last = start;
  const ms: Record<string, number> = {};
  return {
    ms,
    start,
    mark(step: string) {
      const now = Date.now();
      ms[step] = now - last;
      last = now;
      if (step === "queue") ms.total = now - start;
    },
  };
}

/**
 * One log line per capture, so slow steps show up in the Vercel logs.
 * `total` is what the user waited; `background` is the work after the response.
 */
function timingLine(timer: ReturnType<typeof stepTimer>, llm: ReturnType<typeof llmSettings>, usage: LlmUsage | null, fetched: boolean) {
  const { provider, model, effort } = resolveLlm(llm);
  const ms = { ...timer.ms, background: (timer.ms.link ?? 0) + (timer.ms.where ?? 0) };
  return { event: "capture.timing", provider, model, effort, fetched, tokensIn: usage?.tokensIn ?? null, tokensOut: usage?.tokensOut ?? null, ms };
}
