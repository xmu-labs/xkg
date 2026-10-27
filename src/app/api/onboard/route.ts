import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getSession } from "@/lib/session";
import { updateUserRepo, updateUserPin, updateUserApiKey, updateUserLlmKey } from "@/lib/db";
import { hashPin, validatePin } from "@/lib/pin";
import { isLlmProvider, type LlmProvider } from "@/lib/providers";

interface GithubRepoResponse {
  full_name: string;
}

async function githubApiGet(token: string, path: string): Promise<{ ok: boolean; data: unknown; status: number }> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  });
  const data: unknown = res.ok ? await res.json() : null;
  return { ok: res.ok, data, status: res.status };
}

async function githubApiPost(token: string, path: string, body: Record<string, unknown>): Promise<{ ok: boolean; data: unknown; status: number }> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data: unknown = res.ok ? await res.json() : null;
  return { ok: res.ok, data, status: res.status };
}

async function githubApiPut(token: string, path: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status };
}

/**
 * Create the user's knowledge hub.
 *
 * The hub is **private by default**. It holds everything the user captures —
 * reading habits, product thinking, work-in-progress decisions — so making it
 * world-readable is not a default anyone would knowingly choose. Publishing is
 * opt-in via `isPublic`, and an existing repo is never re-scoped: if the repo
 * already exists we return it untouched, so this can't flip someone's
 * deliberately-public (or deliberately-private) hub behind their back.
 */
async function createKnowledgeRepo(
  token: string,
  username: string,
  repoName: string,
  isPublic = false,
): Promise<string> {
  const fullRepo = `${username}/${repoName}`;

  // Check if repo exists
  const check = await githubApiGet(token, `/repos/${fullRepo}`);
  if (check.ok) return fullRepo;

  // Create repo
  const createRes = await githubApiPost(token, "/user/repos", {
    name: repoName,
    description: "Knowledge hub for xkg — captured insights routed to agentic workflows",
    private: !isPublic,
    auto_init: true,
  });

  if (!createRes.ok) throw new Error("Failed to create repository");

  // Wait for GitHub to initialize
  await new Promise((r) => setTimeout(r, 2000));

  // Create INDEX.md
  const indexContent = `# Knowledge Hub — Master Index\n\n> Search by topic, tag, date, or keyword.\n\n| Date | Resource | Keywords | Tags |\n|------|----------|----------|------|\n`;

  await githubApiPut(token, `/repos/${fullRepo}/contents/INDEX.md`, {
    message: "Initialize knowledge hub",
    content: Buffer.from(indexContent).toString("base64"),
  });

  // Create folder structure
  const folders = ["inbox"];
  for (const folder of folders) {
    await githubApiPut(token, `/repos/${fullRepo}/contents/${folder}/.gitkeep`, {
      message: `Create ${folder}/`,
      content: Buffer.from("").toString("base64"),
    });
  }

  // Update README
  const readmeRes = await githubApiGet(token, `/repos/${fullRepo}/contents/README.md`);
  const readmeSha = readmeRes.ok ? ((readmeRes.data as { sha: string }).sha) : undefined;

  const readmeContent = `# My Knowledge Hub\n\nCaptures from [xkg](https://github.com/xmu-labs/xkg) land here automatically.\n\nAll captures go to \`inbox/\` as structured Markdown files. Each file contains the core idea, key takeaways, quotes, tags, and an "Applied to" field linking the insight to something actionable.\n`;

  const readmeBody: Record<string, unknown> = {
    message: "Add knowledge hub README",
    content: Buffer.from(readmeContent).toString("base64"),
  };
  if (readmeSha) readmeBody["sha"] = readmeSha;
  await githubApiPut(token, `/repos/${fullRepo}/contents/README.md`, readmeBody);

  return fullRepo;
}

interface OnboardBody {
  repoName?: string;
  pin?: string;
  /** Opt-in to a public knowledge hub; private when absent. */
  isPublic?: boolean;
  apiKey?: string;
  provider?: LlmProvider;
  anthropicKey?: string; // legacy field — kept for backward compatibility
}

// Wrapped so an escaped exception can never make Next.js answer with HTML —
// the client would then fail on res.json() with a browser-engine error instead
// of the real reason. API routes must always return JSON.
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    return await handlePost(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    console.error("[onboard] unhandled error:", err);
    return NextResponse.json({ error: `[onboard] ${message}` }, { status: 500 });
  }
}

async function handlePost(req: NextRequest): Promise<NextResponse> {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Own try/catch: an unguarded req.json() throw escapes the handler and Next.js
  // answers with HTML, which makes the client's res.json() fail with Safari's
  // "The string did not match the expected pattern." after an HTML response.
  let body: OnboardBody;
  try {
    body = (await req.json()) as OnboardBody;
  } catch {
    return NextResponse.json({ error: "[onboard] Body must be JSON." }, { status: 400 });
  }

  // Accept either the new { apiKey, provider } shape or the legacy { anthropicKey }.
  const llmKey = (body.apiKey ?? body.anthropicKey ?? "").trim();
  const provider: LlmProvider = body.provider ?? "anthropic";

  if (!body.repoName?.trim() || !body.pin?.trim() || !llmKey) {
    return NextResponse.json({ error: "Repo name, PIN, and an LLM API key are required" }, { status: 400 });
  }

  if (!isLlmProvider(provider)) {
    return NextResponse.json({ error: `Unsupported provider: ${provider}` }, { status: 400 });
  }

  // The PIN guards a public login endpoint, so enforce a real minimum here —
  // client-side validation alone is not a control.
  const pinError = validatePin(body.pin);
  if (pinError) {
    return NextResponse.json({ error: pinError }, { status: 400 });
  }

  try {
    // Create knowledge repo
    const fullRepo = await createKnowledgeRepo(
      user.github_token,
      user.github_username,
      body.repoName.trim(),
      body.isPublic === true,
    );

    // Save repo to user
    await updateUserRepo(user.id, fullRepo);

    // Hash and save PIN (salted scrypt — see lib/pin)
    await updateUserPin(user.id, hashPin(body.pin));

    // Save LLM key + provider (BYOK — Anthropic, OpenAI, or Google)
    await updateUserLlmKey(user.id, provider, llmKey);

    // Generate API key for MCP / CLI access
    const apiKey = `xkg_${crypto.randomBytes(24).toString("hex")}`;
    await updateUserApiKey(user.id, apiKey);

    return NextResponse.json({
      ok: true,
      repo: fullRepo,
      repoUrl: `https://github.com/${fullRepo}`,
      apiKey,
    });
  } catch (err) {
    console.error("Onboarding error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to set up" },
      { status: 500 }
    );
  }
}
