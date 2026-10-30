/**
 * Browser sign-in for the CLI, shaped like the OAuth device flow (RFC 8628).
 *
 *   CLI ── start ──> cli_logins (pending, 10 min) ── user opens /api/cli-login/approve?code=…
 *   CLI ── poll every 5 s ─────────────────────────> approve: cli_keys row + key kept encrypted
 *   CLI <── key, once ── row deleted
 *
 * Each approval mints a key for that machine (cli_keys), so signing in on a
 * new machine never replaces the account key or another machine's key.
 * Rotating the key in Settings deletes them all.
 */

import crypto from "crypto";
import { sql } from "./sql";
import { encrypt, decrypt, hashApiKey } from "./crypto";
import { ensureCliKeyTable } from "./db";

export const LOGIN_TTL_SECONDS = 10 * 60;
export const POLL_INTERVAL_SECONDS = 5;
const LABEL_MAX = 64;

/** No vowels, so a code never spells a word (RFC 8628 §6.1). */
const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

export function newUserCode(): string {
  const pick = () => Array.from({ length: 4 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join("");
  return `${pick()}-${pick()}`;
}

/** A code as the user typed it (any case, with or without the dash), or null if it can't be one. */
export function normalizeUserCode(input: string): string | null {
  const letters = input.toUpperCase().replace(/[^A-Z]/g, "");
  if (letters.length !== 8 || [...letters].some((c) => !CODE_ALPHABET.includes(c))) return null;
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

export type PollStatus = "pending" | "slow_down" | "approved" | "denied" | "expired";

interface LoginRow {
  status: "pending" | "approved" | "denied";
  expires_at: Date;
  last_poll_at: Date | null;
}

export function pollStatus(row: LoginRow, now: Date): PollStatus {
  if (new Date(row.expires_at).getTime() <= now.getTime()) return "expired";
  if (row.status !== "pending") return row.status;
  if (row.last_poll_at && now.getTime() - new Date(row.last_poll_at).getTime() < POLL_INTERVAL_SECONDS * 1000) return "slow_down";
  return "pending";
}

export async function createCliLogin(label: string): Promise<{ deviceCode: string; userCode: string; expiresIn: number }> {
  await ensureCliKeyTable();
  await sql`DELETE FROM cli_logins WHERE expires_at < NOW()`;
  const deviceCode = crypto.randomBytes(32).toString("hex");
  const userCode = newUserCode();
  const expiresAt = new Date(Date.now() + LOGIN_TTL_SECONDS * 1000);
  await sql`
    INSERT INTO cli_logins (device_hash, user_code, label, expires_at)
    VALUES (${hashApiKey(deviceCode)}, ${userCode}, ${label.trim().slice(0, LABEL_MAX) || "unnamed machine"}, ${expiresAt})
  `;
  return { deviceCode, userCode, expiresIn: LOGIN_TTL_SECONDS };
}

export async function pollCliLogin(deviceCode: string): Promise<{ status: Exclude<PollStatus, "approved"> } | { status: "approved"; apiKey: string }> {
  await ensureCliKeyTable();
  const deviceHash = hashApiKey(deviceCode);
  const { rows } = await sql<LoginRow>`SELECT status, expires_at, last_poll_at FROM cli_logins WHERE device_hash = ${deviceHash}`;
  const row = rows[0];
  if (!row) return { status: "expired" };

  const status = pollStatus(row, new Date());
  if (status === "approved") {
    // One pickup: the key leaves the database with the row.
    const { rows: taken } = await sql<{ api_key: string | null }>`
      DELETE FROM cli_logins WHERE device_hash = ${deviceHash} AND status = 'approved' RETURNING api_key
    `;
    const apiKey = decrypt(taken[0]?.api_key ?? null);
    return apiKey ? { status: "approved", apiKey } : { status: "expired" };
  }
  if (status === "denied" || status === "expired") {
    await sql`DELETE FROM cli_logins WHERE device_hash = ${deviceHash}`;
    return { status };
  }
  if (status === "pending") await sql`UPDATE cli_logins SET last_poll_at = NOW() WHERE device_hash = ${deviceHash}`;
  return { status };
}

export async function getPendingCliLogin(input: string): Promise<{ userCode: string; label: string } | null> {
  const userCode = normalizeUserCode(input);
  if (!userCode) return null;
  await ensureCliKeyTable();
  const { rows } = await sql<{ user_code: string; label: string }>`
    SELECT user_code, label FROM cli_logins WHERE user_code = ${userCode} AND status = 'pending' AND expires_at > NOW()
  `;
  return rows[0] ? { userCode: rows[0].user_code, label: rows[0].label } : null;
}

/**
 * Approve a pending login for `userId`: mint the machine's key, add it to
 * cli_keys and keep it encrypted on the login for one pickup. One statement,
 * so a login approved twice, or after it expired, adds no key.
 */
export async function approveCliLogin(userCode: string, userId: number): Promise<boolean> {
  await ensureCliKeyTable();
  const apiKey = `xkg_${crypto.randomBytes(24).toString("hex")}`;
  const { rows } = await sql<{ id: number }>`
    WITH approved AS (UPDATE cli_logins SET status = 'approved', user_id = ${userId}, api_key = ${encrypt(apiKey)}
      WHERE user_code = ${userCode} AND status = 'pending' AND expires_at > NOW() RETURNING label)
    INSERT INTO cli_keys (user_id, key_hash, label) SELECT ${userId}, ${hashApiKey(apiKey)}, label FROM approved RETURNING id
  `;
  return rows.length > 0;
}

export async function denyCliLogin(userCode: string): Promise<boolean> {
  await ensureCliKeyTable();
  const { rows } = await sql`
    UPDATE cli_logins SET status = 'denied' WHERE user_code = ${userCode} AND status = 'pending' RETURNING user_code
  `;
  return rows.length > 0;
}
