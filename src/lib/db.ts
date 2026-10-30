import { sql } from "./sql";
import { encrypt, decrypt, hashApiKey, isEncrypted, isHashedApiKey } from "./crypto";
import { isLegacyPinHash, wrapLegacyHash } from "./pin";
import type { LlmEffort, LlmProvider } from "./types";
import type { CodeMapPayload, CodeMapSource, MapFile, StoredCodeMap } from "./code-map";

export type { LlmProvider };

export interface User {
  id: number;
  github_id: number;
  github_username: string;
  github_token: string;
  github_repo: string | null;
  pin_hash: string | null;
  api_key: string | null;
  llm_provider: LlmProvider;
  llm_api_key: string | null;
  /** Model override; null = xkg's default for llm_provider. */
  llm_model?: string | null;
  /** Reasoning effort; null = the model's own default. */
  llm_effort?: LlmEffort | null;
  display_name: string | null;
  avatar_data: string | null;
  /** Bumped to revoke every outstanding session and OAuth token for this user. */
  token_version: number;
  created_at: Date;
}

// ── OAuth (MCP remote connector) types ──

export interface OauthClient {
  client_id: string;
  client_name: string | null;
  redirect_uris: string; // JSON-encoded string[]
  created_at: Date;
}

export interface OauthCode {
  code: string;
  client_id: string;
  user_id: number;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string | null;
  resource: string | null;
  expires_at: Date;
  created_at: Date;
}

// ── Schema initialization ──

export async function initDb(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      github_id INTEGER UNIQUE NOT NULL,
      github_username TEXT NOT NULL,
      github_token TEXT NOT NULL,
      github_repo TEXT,
      pin_hash TEXT,
      api_key TEXT UNIQUE,
      llm_provider TEXT DEFAULT 'anthropic',
      llm_api_key TEXT,
      llm_model TEXT,
      llm_effort TEXT,
      display_name TEXT,
      avatar_data TEXT,
      token_version INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;

  // Additive migration for databases created before token_version existed.
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_data TEXT`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS llm_model TEXT`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS llm_effort TEXT`;

  // Refresh tokens are tracked so they can be single-use with reuse detection
  // (OAuth 2.1 for public clients). Only the jti is stored, never the token.
  await sql`
    CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
      jti TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      client_id TEXT NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      used_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;

  // OAuth 2.1 support for MCP remote connectors (Claude iOS / mobile / web).
  // Clients register dynamically (RFC 7591); authorization codes are short-lived
  // and single-use, carrying the PKCE challenge (RFC 7636). Access/refresh tokens
  // are self-contained signed strings (see lib/oauth.ts) and need no table.
  // Per-user usage quota for expensive endpoints. Distinct from login_attempts:
  // that table counts *failures* and escalates to a lockout, which is the wrong
  // shape here. A capture costs the user real money (it calls their LLM with
  // their key), so what's needed is a ceiling on *successful* calls per window —
  // it bounds what a stolen MCP key can spend before the owner notices.
  await sql`
    CREATE TABLE IF NOT EXISTS usage_quota (
      identifier TEXT PRIMARY KEY,
      used INTEGER NOT NULL DEFAULT 0,
      window_started_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `;

  // Login throttling state. Keyed by lowercased username so a targeted PIN
  // brute force is rate-limited across serverless instances (an in-process
  // counter would reset on every cold start).
  await sql`
    CREATE TABLE IF NOT EXISTS login_attempts (
      identifier TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      lockouts INTEGER NOT NULL DEFAULT 0,
      window_started_at TIMESTAMP NOT NULL DEFAULT NOW(),
      locked_until TIMESTAMP
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id TEXT PRIMARY KEY,
      client_name TEXT,
      redirect_uris TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS oauth_codes (
      code TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      code_challenge_method TEXT NOT NULL,
      scope TEXT,
      resource TEXT,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;

  // One row per application of a capture, counts only (see apply-events.ts).
  // The unique index makes a repeated report of the same capture and commit
  // count once; rows without a commit are never duplicates of each other.
  await sql`
    CREATE TABLE IF NOT EXISTS apply_events (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      capture_key TEXT NOT NULL,
      commit7 TEXT,
      harness TEXT NOT NULL,
      has_why BOOLEAN NOT NULL DEFAULT FALSE,
      applied_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS apply_events_once ON apply_events (user_id, capture_key, commit7)`;
  await sql`CREATE INDEX IF NOT EXISTS apply_events_applied_at ON apply_events (applied_at)`;

  codeMapTableReady = false;
  await ensureCodeMapTable();
  surfaceEventTable = null;
  await ensureSurfaceEventTable();
  handoffEventTable = null;
  await ensureHandoffEventTable();

  await upgradeLegacyData();
}

// ── Code maps (names only; see lib/code-map.ts) ──

/** Repos kept per user; syncing one more drops the least recently synced. */
export const MAX_CODE_MAPS = 20;

let codeMapTableReady = false;

/**
 * One row per user and repo: file paths and exported names, never code.
 * Created on first use as well as by initDb, so a deploy needs no init-db run
 * before the first map arrives.
 */
export async function ensureCodeMapTable(): Promise<void> {
  if (codeMapTableReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS code_maps (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      repo TEXT NOT NULL,
      map JSONB NOT NULL,
      map_hash TEXT NOT NULL,
      head7 TEXT,
      file_count INTEGER NOT NULL,
      truncated BOOLEAN NOT NULL DEFAULT FALSE,
      source TEXT NOT NULL DEFAULT 'local',
      synced_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS code_maps_user_repo ON code_maps (user_id, repo)`;
  codeMapTableReady = true;
}

/**
 * Stores a repo's map, then keeps the user's 20 most recent repos. A map from
 * the user's machine replaces any row; one fetched from GitHub (names only)
 * never replaces a map from the machine. False when nothing was stored.
 */
export async function saveCodeMap(userId: number, map: CodeMapPayload, mapHash: string, source: CodeMapSource = "local"): Promise<boolean> {
  await ensureCodeMapTable();
  const { rowCount } = await sql`
    INSERT INTO code_maps (user_id, repo, map, map_hash, head7, file_count, truncated, source, synced_at)
    VALUES (${userId}, ${map.repo}, ${JSON.stringify(map.files)}::jsonb, ${mapHash}, ${map.head7 || null}, ${map.files.length}, ${map.truncated}, ${source}, NOW())
    ON CONFLICT (user_id, repo) DO UPDATE SET
      map = EXCLUDED.map,
      map_hash = EXCLUDED.map_hash,
      head7 = EXCLUDED.head7,
      file_count = EXCLUDED.file_count,
      truncated = EXCLUDED.truncated,
      source = EXCLUDED.source,
      synced_at = NOW()
    WHERE EXCLUDED.source = 'local' OR code_maps.source = 'github'
    RETURNING id
  `;
  if (!rowCount) return false;
  await sql`
    DELETE FROM code_maps WHERE user_id = ${userId} AND id NOT IN (
      SELECT id FROM code_maps WHERE user_id = ${userId} ORDER BY synced_at DESC, id DESC LIMIT ${MAX_CODE_MAPS}
    )
  `;
  return true;
}

/** Replaces a GitHub map read again at capture time. False when the row is gone or now comes from the user's machine. */
export async function refreshGithubCodeMap(userId: number, map: CodeMapPayload, mapHash: string): Promise<boolean> {
  await ensureCodeMapTable();
  const { rowCount } = await sql`
    UPDATE code_maps SET map = ${JSON.stringify(map.files)}::jsonb, map_hash = ${mapHash}, head7 = NULL,
      file_count = ${map.files.length}, truncated = ${map.truncated}, synced_at = NOW()
    WHERE user_id = ${userId} AND repo = ${map.repo} AND source = 'github' RETURNING id
  `;
  return rowCount > 0;
}

/** The user's most recently synced maps, newest first. */
export async function listCodeMaps(userId: number, limit: number): Promise<StoredCodeMap[]> {
  await ensureCodeMapTable();
  const { rows } = await sql<{ repo: string; map: MapFile[]; head7: string | null; truncated: boolean; source: CodeMapSource; synced_at: Date }>`
    SELECT repo, map, head7, truncated, source, synced_at FROM code_maps WHERE user_id = ${userId}
    ORDER BY synced_at DESC, id DESC LIMIT ${limit}
  `;
  return rows.map((r) => ({ repo: r.repo, files: r.map, head7: r.head7, truncated: r.truncated, source: r.source, syncedAt: new Date(r.synced_at) }));
}

/** The file paths in one repo's stored map, or null when the user has no map for it. */
export async function codeMapPaths(userId: number, repo: string): Promise<Set<string> | null> {
  await ensureCodeMapTable();
  const { rows } = await sql<{ map: MapFile[] }>`
    SELECT map FROM code_maps WHERE user_id = ${userId} AND lower(repo) = ${repo.toLowerCase()} LIMIT 1
  `;
  return rows[0] ? new Set(rows[0].map.map((f) => f.p)) : null;
}

export interface CodeRepo {
  repo: string;
  source: CodeMapSource;
  files: number;
  truncated: boolean;
  syncedAt: Date;
}

/** The user's code repos for Settings, newest first, without their maps. */
export async function listCodeRepos(userId: number): Promise<CodeRepo[]> {
  await ensureCodeMapTable();
  const { rows } = await sql<{ repo: string; source: CodeMapSource; file_count: number; truncated: boolean; synced_at: Date }>`
    SELECT repo, source, file_count, truncated, synced_at FROM code_maps WHERE user_id = ${userId}
    ORDER BY synced_at DESC, id DESC
  `;
  return rows.map((r) => ({ repo: r.repo, source: r.source, files: r.file_count, truncated: r.truncated, syncedAt: new Date(r.synced_at) }));
}

/** Removes one repo's map. False when the user had no such repo. */
export async function deleteCodeMap(userId: number, repo: string): Promise<boolean> {
  await ensureCodeMapTable();
  const { rowCount } = await sql`DELETE FROM code_maps WHERE user_id = ${userId} AND repo = ${repo} RETURNING id`;
  return rowCount > 0;
}

// ── Surface events (counts only; see lib/surface-events.ts) ──

let surfaceEventTable: Promise<void> | null = null;

/**
 * One row each time a channel shows the user a capture (see surface-events.ts).
 * Created on first use as well as by initDb. Concurrent first uses share one
 * creation (two CREATE TABLE IF NOT EXISTS at once can collide); a failed one
 * is retried on the next use.
 */
export function ensureSurfaceEventTable(): Promise<void> {
  surfaceEventTable ??= createSurfaceEventTable().catch((err: unknown) => {
    surfaceEventTable = null;
    throw err;
  });
  return surfaceEventTable;
}

async function createSurfaceEventTable(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS surface_events (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      capture_key TEXT NOT NULL,
      channel TEXT NOT NULL,
      tokens_in INTEGER,
      tokens_out INTEGER,
      model_conf REAL,
      scorer TEXT,
      tier TEXT,
      shown BOOLEAN,
      surfaced_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE surface_events ADD COLUMN IF NOT EXISTS shown BOOLEAN`;
  await sql`CREATE INDEX IF NOT EXISTS surface_events_user_capture ON surface_events (user_id, capture_key)`;
  await sql`CREATE INDEX IF NOT EXISTS surface_events_surfaced_at ON surface_events (surfaced_at)`;
}

// ── Handoff events (counts only; see lib/handoff-events.ts) ──

let handoffEventTable: Promise<void> | null = null;

/** One row per thing that happens to a handoff (see handoff-events.ts). Created on first use, like surface_events. */
export function ensureHandoffEventTable(): Promise<void> {
  handoffEventTable ??= createHandoffEventTable().catch((err: unknown) => {
    handoffEventTable = null;
    throw err;
  });
  return handoffEventTable;
}

async function createHandoffEventTable(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS handoff_events (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      capture_key TEXT NOT NULL,
      repo TEXT NOT NULL,
      event TEXT NOT NULL,
      source TEXT,
      reason TEXT,
      confidence TEXT,
      at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE handoff_events ADD COLUMN IF NOT EXISTS with_commit BOOLEAN`;
  await sql`CREATE INDEX IF NOT EXISTS handoff_events_user_capture ON handoff_events (user_id, capture_key, repo)`;
}

/**
 * Bring rows stored before credentials were protected up to what the Privacy
 * Policy says. Runs from initDb; safe to run repeatedly.
 *
 *  - Plaintext GitHub tokens and LLM keys are encrypted. A GitHub token is
 *    re-encrypted at every sign-in, but an LLM key is only written at
 *    onboarding, so an old one would otherwise stay plaintext for good.
 *  - Plaintext MCP keys are hashed (otherwise upgraded only when next used).
 *  - Unsalted SHA-256 PIN hashes are wrapped in salted scrypt (lib/pin).
 *  - PIN lockout rows keyed by username, from before they were keyed by user
 *    id, are deleted: nothing reads them, and a renamed account's old row
 *    could not be found at account deletion.
 *
 * Each update is conditional on the old value, so a sign-in or onboarding
 * that writes the same column meanwhile is never overwritten.
 */
export async function upgradeLegacyData(): Promise<void> {
  const { rows } = await sql<Pick<User, "id" | "github_token" | "llm_api_key" | "api_key" | "pin_hash">>`
    SELECT id, github_token, llm_api_key, api_key, pin_hash FROM users
  `;
  for (const row of rows) {
    if (row.github_token && !isEncrypted(row.github_token)) {
      await sql`UPDATE users SET github_token = ${encrypt(row.github_token)}
        WHERE id = ${row.id} AND github_token = ${row.github_token}`;
    }
    if (row.llm_api_key && !isEncrypted(row.llm_api_key)) {
      await sql`UPDATE users SET llm_api_key = ${encrypt(row.llm_api_key)}
        WHERE id = ${row.id} AND llm_api_key = ${row.llm_api_key}`;
    }
    if (row.api_key && !isHashedApiKey(row.api_key)) {
      await sql`UPDATE users SET api_key = ${hashApiKey(row.api_key)}
        WHERE id = ${row.id} AND api_key = ${row.api_key}`;
    }
    if (row.pin_hash && isLegacyPinHash(row.pin_hash)) {
      await sql`UPDATE users SET pin_hash = ${wrapLegacyHash(row.pin_hash)}
        WHERE id = ${row.id} AND pin_hash = ${row.pin_hash}`;
    }
  }
  await sql`DELETE FROM login_attempts WHERE identifier NOT LIKE 'user:%'`;
}

// ── Credential hydration ──

/**
 * Decrypt the credential columns on a row read from the database.
 *
 * Storage is encrypted (see lib/crypto); every consumer of `User` expects
 * usable plaintext, so decryption happens here at the single read boundary
 * rather than at each call site. Legacy plaintext rows pass through unchanged
 * and are re-encrypted the next time they're written.
 */
function hydrate(user: User | undefined): User | null {
  if (!user) return null;
  return {
    ...user,
    github_token: decrypt(user.github_token) ?? "",
    llm_api_key: decrypt(user.llm_api_key),
  };
}

// ── Queries ──

export async function getUserByGithubId(githubId: number): Promise<User | null> {
  const { rows } = await sql<User>`
    SELECT * FROM users WHERE github_id = ${githubId} LIMIT 1
  `;
  return hydrate(rows[0]);
}

export async function getUserById(id: number): Promise<User | null> {
  const { rows } = await sql<User>`
    SELECT * FROM users WHERE id = ${id} LIMIT 1
  `;
  return hydrate(rows[0]);
}

export async function createUser(
  githubId: number,
  githubUsername: string,
  githubToken: string
): Promise<User> {
  const stored = encrypt(githubToken);
  const { rows } = await sql<User>`
    INSERT INTO users (github_id, github_username, github_token)
    VALUES (${githubId}, ${githubUsername}, ${stored})
    ON CONFLICT (github_id) DO UPDATE SET
      github_username = ${githubUsername},
      github_token = ${stored}
    RETURNING *
  `;
  return hydrate(rows[0]) as User;
}

export async function updateUserRepo(userId: number, repo: string): Promise<void> {
  await sql`UPDATE users SET github_repo = ${repo} WHERE id = ${userId}`;
}

export async function updateUserPin(userId: number, pinHash: string): Promise<void> {
  await sql`UPDATE users SET pin_hash = ${pinHash} WHERE id = ${userId}`;
}

export async function updateUserProfile(
  userId: number,
  fields: { displayName?: string | null; avatarData?: string | null },
): Promise<void> {
  // In-app profile only. Never writes back to GitHub.
  await ensureProfileColumns();
  if (fields.displayName !== undefined) {
    await sql`UPDATE users SET display_name = ${fields.displayName} WHERE id = ${userId}`;
  }
  if (fields.avatarData !== undefined) {
    await sql`UPDATE users SET avatar_data = ${fields.avatarData} WHERE id = ${userId}`;
  }
}

let profileColumnsReady = false;

export async function ensureProfileColumns(): Promise<void> {
  if (profileColumnsReady) return;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_data TEXT`;
  profileColumnsReady = true;
}

/**
 * Resolve a user from an MCP API key.
 *
 * Keys are stored hashed, so the incoming key is hashed and matched against
 * that. A legacy plaintext row still matches on the raw value and is upgraded
 * to a hash in place, so existing keys keep working without a forced rotation.
 */
export async function getUserByApiKey(apiKey: string): Promise<User | null> {
  const hashed = hashApiKey(apiKey);
  const { rows } = await sql<User>`
    SELECT * FROM users WHERE api_key = ${hashed} LIMIT 1
  `;
  if (rows[0]) return hydrate(rows[0]);

  const { rows: legacy } = await sql<User>`
    SELECT * FROM users WHERE api_key = ${apiKey} LIMIT 1
  `;
  const found = legacy[0];
  if (!found) return null;

  try {
    await sql`UPDATE users SET api_key = ${hashed} WHERE id = ${found.id}`;
  } catch {
    // A failed upgrade must not break a valid key.
  }
  return hydrate(found);
}

/** Store an MCP API key as a hash. The plaintext is shown to the user once. */
export async function updateUserApiKey(userId: number, apiKey: string): Promise<void> {
  await sql`UPDATE users SET api_key = ${hashApiKey(apiKey)} WHERE id = ${userId}`;
}

export async function updateUserLlmKey(userId: number, provider: LlmProvider, apiKey: string): Promise<void> {
  const stored = encrypt(apiKey);
  await sql`UPDATE users SET llm_provider = ${provider}, llm_api_key = ${stored} WHERE id = ${userId}`;
}

let llmColumnsReady = false;

/** Same lazy migration as ensureProfileColumns, for deployments that predate model choice. */
export async function ensureLlmColumns(): Promise<void> {
  if (llmColumnsReady) return;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS llm_model TEXT`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS llm_effort TEXT`;
  llmColumnsReady = true;
}

export async function updateUserLlmSettings(
  userId: number,
  model: string | null,
  effort: LlmEffort | null,
): Promise<void> {
  await ensureLlmColumns();
  await sql`UPDATE users SET llm_model = ${model}, llm_effort = ${effort} WHERE id = ${userId}`;
}

export async function getUserByUsername(username: string): Promise<User | null> {
  const { rows } = await sql<User>`
    SELECT * FROM users WHERE github_username = ${username} LIMIT 1
  `;
  return hydrate(rows[0]);
}

export async function getUserCount(): Promise<number> {
  const { rows } = await sql<{ count: string }>`SELECT COUNT(*) as count FROM users`;
  return parseInt(rows[0]?.count ?? "0", 10);
}

// ── OAuth queries ──

export async function createOauthClient(
  clientId: string,
  clientName: string | null,
  redirectUris: string[],
): Promise<void> {
  await sql`
    INSERT INTO oauth_clients (client_id, client_name, redirect_uris)
    VALUES (${clientId}, ${clientName}, ${JSON.stringify(redirectUris)})
    ON CONFLICT (client_id) DO NOTHING
  `;
}

export async function getOauthClient(clientId: string): Promise<OauthClient | null> {
  const { rows } = await sql<OauthClient>`
    SELECT * FROM oauth_clients WHERE client_id = ${clientId} LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function createOauthCode(code: OauthCode): Promise<void> {
  await sql`
    INSERT INTO oauth_codes
      (code, client_id, user_id, redirect_uri, code_challenge, code_challenge_method, scope, resource, expires_at)
    VALUES (
      ${code.code}, ${code.client_id}, ${code.user_id}, ${code.redirect_uri},
      ${code.code_challenge}, ${code.code_challenge_method}, ${code.scope}, ${code.resource},
      ${code.expires_at.toISOString()}
    )
  `;
}

/** Atomically fetch and delete an authorization code, enforcing single use. */
export async function consumeOauthCode(code: string): Promise<OauthCode | null> {
  const { rows } = await sql<OauthCode>`
    DELETE FROM oauth_codes WHERE code = ${code} RETURNING *
  `;
  return rows[0] ?? null;
}

/**
 * Bump a user's token_version, invalidating every session cookie and OAuth
 * access/refresh token issued before now. Returns the new version.
 */
export async function revokeUserTokens(userId: number): Promise<number> {
  const { rows } = await sql<{ token_version: number }>`
    UPDATE users SET token_version = token_version + 1
    WHERE id = ${userId}
    RETURNING token_version
  `;
  return rows[0]?.token_version ?? 0;
}

/**
 * Delete everything xkg holds about a user: the account row and every record
 * keyed to it. Captures are untouched — they live in the user's GitHub repo.
 *
 * The users row goes last. A failure part-way leaves the account in place, so
 * the user can retry from Settings; deleting it first would strand the other
 * rows with no way back to them.
 */
export async function deleteUserData(userId: number, username: string): Promise<void> {
  await sql`DELETE FROM oauth_refresh_tokens WHERE user_id = ${userId}`;
  await sql`DELETE FROM oauth_codes WHERE user_id = ${userId}`;
  await sql`DELETE FROM usage_quota WHERE identifier IN (${`capture:user:${userId}`}, ${`code-map:user:${userId}`}, ${`handoff:user:${userId}`})`;
  // PIN lockouts are keyed by user id; rows from before that were keyed by username.
  await sql`
    DELETE FROM login_attempts
    WHERE identifier IN (${`user:${userId}`}, ${username.toLowerCase()})
  `;
  await sql`DELETE FROM apply_events WHERE user_id = ${userId}`;
  await ensureCodeMapTable();
  await sql`DELETE FROM code_maps WHERE user_id = ${userId}`;
  await ensureSurfaceEventTable();
  await sql`DELETE FROM surface_events WHERE user_id = ${userId}`;
  await ensureHandoffEventTable();
  await sql`DELETE FROM handoff_events WHERE user_id = ${userId}`;
  await sql`DELETE FROM users WHERE id = ${userId}`;
}

// ── OAuth refresh token tracking ──

export interface RefreshRecord {
  jti: string;
  user_id: number;
  client_id: string;
  expires_at: Date;
  used_at: Date | null;
}

export async function recordRefreshToken(
  jti: string,
  userId: number,
  clientId: string,
  expiresAt: Date,
): Promise<void> {
  await sql`
    INSERT INTO oauth_refresh_tokens (jti, user_id, client_id, expires_at)
    VALUES (${jti}, ${userId}, ${clientId}, ${expiresAt.toISOString()})
    ON CONFLICT (jti) DO NOTHING
  `;
}

export type RefreshConsumeResult =
  | { status: "ok"; record: RefreshRecord }
  | { status: "reused"; record: RefreshRecord }
  | { status: "unknown" };

/**
 * Atomically claim a refresh token for single use.
 *
 * The `used_at IS NULL` predicate makes the claim itself the concurrency
 * control: exactly one caller can win, so two clients replaying the same token
 * cannot both succeed. A miss is then disambiguated with a follow-up read —
 * "reused" is the signal to revoke the whole family, "unknown" is just an
 * invalid token.
 */
export async function consumeRefreshToken(jti: string): Promise<RefreshConsumeResult> {
  const { rows } = await sql<RefreshRecord>`
    UPDATE oauth_refresh_tokens SET used_at = NOW()
    WHERE jti = ${jti} AND used_at IS NULL
    RETURNING jti, user_id, client_id, expires_at, used_at
  `;
  if (rows[0]) return { status: "ok", record: rows[0] };

  const { rows: existing } = await sql<RefreshRecord>`
    SELECT jti, user_id, client_id, expires_at, used_at
    FROM oauth_refresh_tokens WHERE jti = ${jti} LIMIT 1
  `;
  return existing[0] ? { status: "reused", record: existing[0] } : { status: "unknown" };
}

/** Drop every refresh token for a user+client pair (a detected-reuse response). */
export async function revokeRefreshFamily(userId: number, clientId: string): Promise<void> {
  await sql`
    DELETE FROM oauth_refresh_tokens
    WHERE user_id = ${userId} AND client_id = ${clientId}
  `;
}

/** Best-effort cleanup of expired refresh tokens. */
export async function deleteExpiredRefreshTokens(): Promise<void> {
  await sql`DELETE FROM oauth_refresh_tokens WHERE expires_at < NOW()`;
}

/** Best-effort cleanup of expired authorization codes. */
export async function deleteExpiredOauthCodes(): Promise<void> {
  await sql`DELETE FROM oauth_codes WHERE expires_at < NOW()`;
}
