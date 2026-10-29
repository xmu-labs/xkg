import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";
import { getSession } from "@/lib/session";
import { ensureLlmColumns, ensureProfileColumns, updateUserLlmKey, updateUserLlmSettings, updateUserProfile, updateUserRepo } from "@/lib/db";
import { currentRepoName } from "@/lib/github";
import { LLM_EFFORTS, LLM_PROVIDERS, defaultModel, validateLlmModel, verifyLlmKey } from "@/lib/llm";
import type { LlmEffort, LlmProvider } from "@/lib/types";
import {
  githubAvatarUrl,
  validateAvatarData,
  validateDisplayName,
} from "@/lib/profile";

function appVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function mePayload(user: {
  github_username: string;
  display_name: string | null;
  avatar_data: string | null;
  api_key: string | null;
  pin_hash: string | null;
  llm_provider: LlmProvider;
  llm_api_key?: string | null;
  llm_model?: string | null;
  llm_effort?: LlmEffort | null;
  github_repo?: string | null;
}) {
  return {
    githubUsername: user.github_username,
    displayName: user.display_name?.trim() || user.github_username,
    avatarUrl: user.avatar_data || githubAvatarUrl(user.github_username),
    hasCustomAvatar: Boolean(user.avatar_data),
    hasMcpKey: Boolean(user.api_key),
    hasPin: Boolean(user.pin_hash),
    llmProvider: user.llm_provider,
    // The last four characters only, so Settings can say which key is saved.
    llmKeyHint: user.llm_api_key && user.llm_api_key.length > 8 ? user.llm_api_key.slice(-4) : null,
    llmModel: user.llm_model ?? null,
    llmEffort: user.llm_effort ?? null,
    defaultModel: defaultModel(user.llm_provider),
    knowledgeRepo: user.github_repo ?? null,
    version: appVersion(),
  };
}

export async function GET(): Promise<NextResponse> {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    await ensureProfileColumns();
    await ensureLlmColumns();
    // Follow a rename on GitHub, so xkg doesn't rely on the redirect from the
    // old name, which stops working if a new repo takes that name.
    if (user.github_repo) {
      const current = await currentRepoName(user.github_token, user.github_repo);
      if (current && current !== user.github_repo) {
        await updateUserRepo(user.id, current);
        user.github_repo = current;
      }
    }
    return NextResponse.json(mePayload(user));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load profile";
    return NextResponse.json({ error: `[me] ${message}` }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

    let body: {
      displayName?: unknown;
      avatarData?: unknown;
      llmProvider?: unknown;
      llmApiKey?: unknown;
      llmModel?: unknown;
      llmEffort?: unknown;
    };
    try {
      body = await req.json() as typeof body;
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const fields: { displayName?: string | null; avatarData?: string | null } = {};

    if ("displayName" in body) {
      if (typeof body.displayName !== "string") {
        return NextResponse.json({ error: "Name must be a string." }, { status: 400 });
      }
      const error = validateDisplayName(body.displayName);
      if (error) return NextResponse.json({ error }, { status: 400 });
      fields.displayName = body.displayName.trim();
    }

    if ("avatarData" in body) {
      if (body.avatarData === null) {
        fields.avatarData = null;
      } else if (typeof body.avatarData === "string") {
        const error = validateAvatarData(body.avatarData);
        if (error) return NextResponse.json({ error }, { status: 400 });
        fields.avatarData = body.avatarData;
      } else {
        return NextResponse.json({ error: "Invalid image." }, { status: 400 });
      }
    }

    // A new key may come with a new provider; a new provider always needs a new
    // key, since keys don't carry across providers.
    let llmProvider = user.llm_provider;
    let llmApiKey: string | null = null;
    if ("llmProvider" in body) {
      if (!LLM_PROVIDERS.includes(body.llmProvider as LlmProvider)) {
        return NextResponse.json({ error: `Provider must be one of: ${LLM_PROVIDERS.join(", ")}.` }, { status: 400 });
      }
      llmProvider = body.llmProvider as LlmProvider;
    }
    if ("llmApiKey" in body) {
      if (typeof body.llmApiKey !== "string" || !body.llmApiKey.trim()) {
        return NextResponse.json({ error: "Paste an API key." }, { status: 400 });
      }
      llmApiKey = body.llmApiKey.trim();
      if (llmApiKey.length > 500 || /\s/.test(llmApiKey)) {
        return NextResponse.json({ error: "That doesn't look like an API key." }, { status: 400 });
      }
    }
    const providerChanged = llmProvider !== user.llm_provider;
    if (providerChanged && !llmApiKey) {
      return NextResponse.json({ error: "Switching provider needs that provider's API key." }, { status: 400 });
    }
    if (llmApiKey) {
      const error = await verifyLlmKey(llmProvider, llmApiKey);
      if (error) return NextResponse.json({ error }, { status: 400 });
    }

    // Model and effort are saved together: the pair is what the next LLM call uses.
    // A saved model belongs to the old provider, so switching clears it.
    const llmChange = "llmModel" in body || "llmEffort" in body || providerChanged;
    let llmModel = providerChanged ? null : user.llm_model ?? null;
    let llmEffort = user.llm_effort ?? null;
    if ("llmModel" in body) {
      if (body.llmModel === null || body.llmModel === "") {
        llmModel = null;
      } else if (typeof body.llmModel === "string") {
        const trimmed = body.llmModel.trim();
        const error = validateLlmModel(trimmed);
        if (error) return NextResponse.json({ error }, { status: 400 });
        llmModel = trimmed;
      } else {
        return NextResponse.json({ error: "Model must be a string." }, { status: 400 });
      }
    }
    if ("llmEffort" in body) {
      if (body.llmEffort === null || body.llmEffort === "") {
        llmEffort = null;
      } else if (LLM_EFFORTS.includes(body.llmEffort as LlmEffort)) {
        llmEffort = body.llmEffort as LlmEffort;
      } else {
        return NextResponse.json({ error: "Effort must be low, medium or high." }, { status: 400 });
      }
    }

    if (fields.displayName === undefined && fields.avatarData === undefined && !llmChange && !llmApiKey) {
      return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
    }

    if (fields.displayName !== undefined || fields.avatarData !== undefined) {
      await updateUserProfile(user.id, fields);
    }
    if (llmApiKey) await updateUserLlmKey(user.id, llmProvider, llmApiKey);
    if (llmChange) await updateUserLlmSettings(user.id, llmModel, llmEffort);
    const next = {
      ...user,
      display_name: fields.displayName !== undefined ? fields.displayName : user.display_name,
      avatar_data: fields.avatarData !== undefined ? fields.avatarData : user.avatar_data,
      llm_provider: llmProvider,
      llm_api_key: llmApiKey ?? user.llm_api_key,
      llm_model: llmModel,
      llm_effort: llmEffort,
    };
    return NextResponse.json(mePayload(next));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update profile";
    return NextResponse.json({ error: `[me] ${message}` }, { status: 500 });
  }
}
