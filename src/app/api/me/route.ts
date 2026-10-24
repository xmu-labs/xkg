import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";
import { getSession } from "@/lib/session";
import { ensureLlmColumns, ensureProfileColumns, updateUserLlmSettings, updateUserProfile } from "@/lib/db";
import { LLM_EFFORTS, defaultModel, validateLlmModel } from "@/lib/llm";
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
  llm_model?: string | null;
  llm_effort?: LlmEffort | null;
}) {
  return {
    githubUsername: user.github_username,
    displayName: user.display_name?.trim() || user.github_username,
    avatarUrl: user.avatar_data || githubAvatarUrl(user.github_username),
    hasCustomAvatar: Boolean(user.avatar_data),
    hasMcpKey: Boolean(user.api_key),
    hasPin: Boolean(user.pin_hash),
    llmProvider: user.llm_provider,
    llmModel: user.llm_model ?? null,
    llmEffort: user.llm_effort ?? null,
    defaultModel: defaultModel(user.llm_provider),
    version: appVersion(),
  };
}

export async function GET(): Promise<NextResponse> {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    await ensureProfileColumns();
    await ensureLlmColumns();
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

    let body: { displayName?: unknown; avatarData?: unknown; llmModel?: unknown; llmEffort?: unknown };
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

    // Model and effort are saved together: the pair is what the next LLM call uses.
    const llmChange = "llmModel" in body || "llmEffort" in body;
    let llmModel = user.llm_model ?? null;
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

    if (fields.displayName === undefined && fields.avatarData === undefined && !llmChange) {
      return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
    }

    if (fields.displayName !== undefined || fields.avatarData !== undefined) {
      await updateUserProfile(user.id, fields);
    }
    if (llmChange) await updateUserLlmSettings(user.id, llmModel, llmEffort);
    const next = {
      ...user,
      display_name: fields.displayName !== undefined ? fields.displayName : user.display_name,
      avatar_data: fields.avatarData !== undefined ? fields.avatarData : user.avatar_data,
      llm_model: llmModel,
      llm_effort: llmEffort,
    };
    return NextResponse.json(mePayload(next));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update profile";
    return NextResponse.json({ error: `[me] ${message}` }, { status: 500 });
  }
}
