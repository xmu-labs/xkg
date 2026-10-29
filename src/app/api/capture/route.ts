import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { githubPut, appendToIndex, readFile } from "@/lib/github";
import { extractCapture, formatDate, buildMarkdown, buildIndexRow, detectSourceType, llmSettings } from "@/lib/llm";
import { fetchSourceContent } from "@/lib/fetch-source";
import { linkCapture } from "@/lib/linking";
import { consumeQuota } from "@/lib/rate-limit";
import { captureFileUrl } from "@/lib/captureFileUrl";
import { matchCapture, whereCard, writeWhereSection } from "@/lib/where";
import { recordWhereEvent } from "@/lib/surface-events";

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

  // For a bare URL, fetch the live page server-side so the LLM reasons over the
  // page's real content instead of guessing from training data (which risks
  // fabricated insights or a timeout-driven "Load failed"). Best-effort: on any
  // failure we fall back to URL-only mode and pass the raw URL string through.
  let llmContent = content;
  const sourceUrl = sourceType === "url" ? content.trim() : undefined;
  if (sourceUrl) {
    const fetched = await fetchSourceContent(sourceUrl);
    if (fetched) llmContent = fetched;
  }

  // Extract insights via LLM
  let capture;
  try {
    capture = await extractCapture(user.llm_api_key, llmContent, title, llmSettings(user), { url: sourceUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Extraction failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  // Where it applies: one more LLM call, started now so it runs alongside
  // writing and linking instead of after them. Never throws.
  const matching = matchCapture(user, capture);

  // Build Markdown and commit to user's repo
  const date = formatDate();
  const filename = `${date}-${capture.slug}.md`;
  const markdown = buildMarkdown(date, capture, content, sourceType);

  await githubPut(
    user.github_token,
    user.github_repo,
    `inbox/${filename}`,
    markdown,
    `capture: add ${filename}`,
  );

  // Update INDEX.md
  const row = buildIndexRow(date, capture, filename, sourceType);
  await appendToIndex(user.github_token, user.github_repo, row, `capture: update index for ${filename}`);

  // Auto-link to related captures (best-effort)
  if (user.llm_api_key) {
    try {
      const indexFile = await readFile(user.github_token, user.github_repo, "INDEX.md");
      if (indexFile) {
        await linkCapture(user.llm_api_key, user.github_token, user.github_repo, capture, filename, "inbox", indexFile.content, llmSettings(user));
      }
    } catch {
      // Linking is best-effort
    }
  }

  const where = await matching;
  if (where) {
    await Promise.all([
      writeWhereSection(user.github_token, user.github_repo, `inbox/${filename}`, where),
      recordWhereEvent(user.id, `inbox/${filename}`, where),
    ]);
  }

  return NextResponse.json({
    capture,
    filename,
    fileUrl: captureFileUrl(user.github_repo, filename),
    ...(where ? { where: whereCard(where) } : {}),
  });
}
