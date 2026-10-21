/**
 * Encryption at rest for stored third-party credentials.
 *
 * The users table holds a GitHub OAuth token (repo scope), an LLM API key,
 * and the MCP API key. In plaintext, a single database read hands an attacker
 * working credentials for every user's repositories and billable LLM account.
 *
 * Two different problems, two different tools:
 *
 *  - github_token / llm_api_key must be *recoverable* (they're replayed to
 *    GitHub and the LLM provider), so they're encrypted with AES-256-GCM.
 *  - api_key is only ever *compared*, so it's stored as a hash and never
 *    recoverable at all.
 *
 * The key is derived from SESSION_SECRET with HKDF rather than introducing a
 * new environment variable, matching the approach already taken in lib/oauth.
 * Rotating SESSION_SECRET therefore invalidates stored ciphertexts — see the
 * README note.
 */

import crypto from "crypto";
import { env } from "./env";

const ENC_PREFIX = "enc:v1:";
const HASH_PREFIX = "sha256:";
// Keeps the pre-rename name on purpose: it is an input to key derivation, so
// changing it makes every stored GitHub token and LLM key undecryptable.
const KEY_INFO = "mnemos:credential-encryption:v1";
const IV_BYTES = 12; // GCM standard nonce size
const TAG_BYTES = 16;

function key(): Buffer {
  // HKDF with a fixed info label gives this use a key distinct from the raw
  // SESSION_SECRET used for cookie and OAuth token signatures.
  return Buffer.from(
    crypto.hkdfSync("sha256", Buffer.from(env.sessionSecret), Buffer.alloc(0), Buffer.from(KEY_INFO), 32),
  );
}

/** True when a stored value is already ciphertext produced by `encrypt`. */
export function isEncrypted(value: string): boolean {
  return typeof value === "string" && value.startsWith(ENC_PREFIX);
}

/** Encrypt a credential for storage. */
export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, tag, enc]).toString("base64");
}

/**
 * Decrypt a stored credential.
 *
 * A value without the ciphertext prefix is a legacy plaintext row and is
 * returned as-is, so existing users keep working; callers re-encrypt on the
 * next write. Returns null when a prefixed value fails to decrypt or
 * authenticate (tampering, or a rotated SESSION_SECRET).
 */
export function decrypt(stored: string | null): string | null {
  if (!stored) return null;
  if (!isEncrypted(stored)) return stored; // legacy plaintext

  try {
    const raw = Buffer.from(stored.slice(ENC_PREFIX.length), "base64");
    // Exactly IV+TAG is a valid encryption of the empty string; shorter is truncated.
    if (raw.length < IV_BYTES + TAG_BYTES) return null;

    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const body = raw.subarray(IV_BYTES + TAG_BYTES);

    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf-8");
  } catch {
    return null;
  }
}

/**
 * Hash an MCP API key for storage and lookup.
 *
 * A plain SHA-256 is right here (unlike the PIN): the key is 192 bits of
 * `crypto.randomBytes`, so there is no dictionary to attack and no need for a
 * slow KDF — which would also make every MCP request pay the cost.
 */
export function hashApiKey(apiKey: string): string {
  return HASH_PREFIX + crypto.createHash("sha256").update(apiKey).digest("hex");
}
