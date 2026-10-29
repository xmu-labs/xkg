import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { getUserByApiKey, saveCodeMap } from "@/lib/db";
import { consumeQuota } from "@/lib/rate-limit";
import { CODE_MAP_QUOTA, MAX_MAP_BODY_BYTES, parseCodeMap } from "@/lib/code-map";

function fail(status: number, error: string, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json({ ok: false, error }, { status, headers });
}

/**
 * Receives a repo's code map from the CLI's git hooks (any agent, or none).
 * A REST endpoint rather than an MCP tool: agents never need to call it.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const key = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1]?.trim();
    const user = key ? await getUserByApiKey(key) : null;
    if (!user) return fail(401, "Missing or invalid xkg API key.");

    const quota = await consumeQuota(`code-map:user:${user.id}`, CODE_MAP_QUOTA);
    if (!quota.allowed) {
      return fail(429, `Rate limit reached: ${quota.limit} map syncs per hour.`, { "Retry-After": String(quota.resetIn) });
    }

    if (Number(req.headers.get("content-length") ?? 0) > MAX_MAP_BODY_BYTES) return fail(413, "Map is over 150 KB.");
    const text = await req.text();
    if (Buffer.byteLength(text) > MAX_MAP_BODY_BYTES) return fail(413, "Map is over 150 KB.");

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return fail(400, "Invalid JSON.");
    }
    const parsed = parseCodeMap(body);
    if (!parsed.ok) return fail(400, parsed.error);

    const { map } = parsed;
    const hash = createHash("sha256").update(JSON.stringify({ files: map.files, truncated: map.truncated })).digest("hex");
    await saveCodeMap(user.id, map, hash);
    return NextResponse.json({ ok: true, files: map.files.length, truncated: map.truncated });
  } catch (err) {
    return fail(500, `[code-map] ${err instanceof Error ? err.message : "Failed to save the map"}`);
  }
}
