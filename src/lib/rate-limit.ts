/**
 * Database-backed login throttling.
 *
 * The app runs on serverless functions, so an in-process counter is useless —
 * each invocation may land on a fresh instance. Attempts are recorded in a
 * small table keyed by a caller-supplied identifier (the lowercased username),
 * which is what makes a targeted PIN brute force infeasible.
 *
 * Lockouts are time-boxed rather than permanent: a permanent lock would let
 * anyone who knows a username deny that user access indefinitely.
 */

import { sql } from "./sql";

/** Failures allowed inside one window before the identifier is locked. */
export const MAX_ATTEMPTS = 5;
/** Sliding window over which failures accumulate. */
export const WINDOW_SECONDS = 15 * 60;
/** Base lockout, doubled for each additional lockout, capped below. */
export const BASE_LOCKOUT_SECONDS = 15 * 60;
export const MAX_LOCKOUT_SECONDS = 24 * 60 * 60;

export interface LockState {
  locked: boolean;
  /** Seconds until the lock expires; 0 when not locked. */
  retryAfter: number;
}

interface AttemptRow {
  attempts: number;
  lockouts: number;
  window_started_at: Date;
  locked_until: Date | null;
}

/**
 * Compute the lockout duration for the Nth lockout of an identifier.
 * Exported for testing; exponential with a hard cap.
 */
export function lockoutSeconds(lockoutCount: number): number {
  const n = Math.max(0, lockoutCount);
  const seconds = BASE_LOCKOUT_SECONDS * Math.pow(2, n);
  return Math.min(seconds, MAX_LOCKOUT_SECONDS);
}

/** Check whether an identifier is currently locked out. */
export async function checkLock(identifier: string): Promise<LockState> {
  const key = identifier.toLowerCase();
  const { rows } = await sql<AttemptRow>`
    SELECT attempts, lockouts, window_started_at, locked_until
    FROM login_attempts WHERE identifier = ${key} LIMIT 1
  `;
  const row = rows[0];
  if (!row?.locked_until) return { locked: false, retryAfter: 0 };

  const remainingMs = new Date(row.locked_until).getTime() - Date.now();
  if (remainingMs <= 0) return { locked: false, retryAfter: 0 };
  return { locked: true, retryAfter: Math.ceil(remainingMs / 1000) };
}

/**
 * Record a failed attempt, locking the identifier once it exceeds MAX_ATTEMPTS
 * inside the window. Returns the resulting lock state.
 */
export async function recordFailure(identifier: string): Promise<LockState> {
  const key = identifier.toLowerCase();

  // Reset the counter when the previous window has fully elapsed, so occasional
  // typos months apart never accumulate into a lockout.
  const { rows } = await sql<AttemptRow>`
    INSERT INTO login_attempts (identifier, attempts, lockouts, window_started_at)
    VALUES (${key}, 1, 0, NOW())
    ON CONFLICT (identifier) DO UPDATE SET
      attempts = CASE
        WHEN login_attempts.window_started_at < NOW() - (${WINDOW_SECONDS} * INTERVAL '1 second')
        THEN 1 ELSE login_attempts.attempts + 1 END,
      window_started_at = CASE
        WHEN login_attempts.window_started_at < NOW() - (${WINDOW_SECONDS} * INTERVAL '1 second')
        THEN NOW() ELSE login_attempts.window_started_at END
    RETURNING attempts, lockouts, window_started_at, locked_until
  `;

  const row = rows[0];
  if (!row || row.attempts < MAX_ATTEMPTS) {
    return { locked: false, retryAfter: 0 };
  }

  const seconds = lockoutSeconds(row.lockouts);
  const { rows: locked } = await sql<AttemptRow>`
    UPDATE login_attempts
    SET locked_until = NOW() + (${seconds} * INTERVAL '1 second'),
        lockouts = lockouts + 1,
        attempts = 0,
        window_started_at = NOW()
    WHERE identifier = ${key}
    RETURNING attempts, lockouts, window_started_at, locked_until
  `;

  const until = locked[0]?.locked_until;
  const retryAfter = until
    ? Math.max(1, Math.ceil((new Date(until).getTime() - Date.now()) / 1000))
    : seconds;
  return { locked: true, retryAfter };
}

/** Clear all failure state for an identifier after a successful login. */
export async function clearAttempts(identifier: string): Promise<void> {
  await sql`DELETE FROM login_attempts WHERE identifier = ${identifier.toLowerCase()}`;
}

// ── Usage quota ──
//
// Separate concern from the lockout above. That one counts failed *attempts* and
// escalates; this one counts *successful* calls against a ceiling. Capture spends
// the user's own LLM credits, so an attacker holding a stolen MCP key could run up
// their bill unbounded. A per-user window caps the damage.

/** Captures allowed per user per window. Generous for a human, bounded for a script. */
export const CAPTURE_QUOTA = 60;
export const QUOTA_WINDOW_SECONDS = 60 * 60;

export interface QuotaState {
  /** The window this unit was charged to; refundQuota needs it back. */
  windowStartedAt: Date;
  allowed: boolean;
  used: number;
  limit: number;
  /** Seconds until the window resets. */
  resetIn: number;
}

/**
 * Consume one unit of a user's quota. Increments and reports the result in a
 * single statement, so concurrent requests cannot both slip past the ceiling.
 * The window resets by moving `window_started_at`, not by a scheduled job.
 */
export async function consumeQuota(
  identifier: string,
  limit = CAPTURE_QUOTA,
  windowSeconds = QUOTA_WINDOW_SECONDS,
): Promise<QuotaState> {
  const key = identifier.toLowerCase();

  const { rows } = await sql<{ used: number; window_started_at: Date }>`
    INSERT INTO usage_quota (identifier, used, window_started_at)
    VALUES (${key}, 1, NOW())
    ON CONFLICT (identifier) DO UPDATE SET
      used = CASE
        WHEN usage_quota.window_started_at < NOW() - (${windowSeconds} * INTERVAL '1 second')
        THEN 1 ELSE usage_quota.used + 1 END,
      window_started_at = CASE
        WHEN usage_quota.window_started_at < NOW() - (${windowSeconds} * INTERVAL '1 second')
        THEN NOW() ELSE usage_quota.window_started_at END
    RETURNING used, window_started_at
  `;

  const row = rows[0];
  const used = row?.used ?? 1;
  const startedAt = row?.window_started_at ? new Date(row.window_started_at).getTime() : Date.now();
  const resetIn = Math.max(
    1,
    Math.ceil((startedAt + windowSeconds * 1000 - Date.now()) / 1000),
  );

  return { allowed: used <= limit, used, limit, resetIn, windowStartedAt: new Date(startedAt) };
}

/**
 * Give one unit back, so a capture that failed before it cost anything (the
 * provider was down, the key was rejected) doesn't count against the hour.
 * Only the window the unit was charged to is touched: if the window rolled
 * over in between, the new window's count belongs to other requests. Never
 * below zero.
 */
export async function refundQuota(identifier: string, windowStartedAt: Date): Promise<void> {
  const key = identifier.toLowerCase();
  await sql`
    UPDATE usage_quota SET used = GREATEST(used - 1, 0)
    WHERE identifier = ${key} AND window_started_at = ${windowStartedAt.toISOString()}
  `;
}
