/**
 * PIN hashing and verification.
 *
 * PINs are low-entropy secrets, so the stored hash must be *slow* to compute:
 * an unsalted SHA-256 of a 6-digit PIN falls to exhaustive search in
 * milliseconds if the database ever leaks. Hashes are scrypt with a per-user
 * random salt, serialized as:
 *
 *     scrypt$<N>$<r>$<p>$<saltBase64>$<hashBase64>
 *
 * Legacy hashes (bare 64-char hex = the old unsalted SHA-256) still verify, so
 * existing users can sign in; `needsRehash` tells the caller to transparently
 * upgrade the stored hash on the next successful login.
 *
 * Stored legacy hashes are also wrapped in bulk, without the PIN, by
 * `wrapLegacyHash` (see upgradeLegacyData in lib/db):
 *
 *     scrypt-sha256$<N>$<r>$<p>$<saltBase64>$<hashBase64>   = scrypt(sha256hex(pin))
 *
 * which verifies the same PIN and is re-hashed plainly at the next login.
 */

import crypto from "crypto";

/** Minimum PIN length. Short PINs are the main brute-force risk. */
export const MIN_PIN_LENGTH = 6;
/** Upper bound so a huge input can't be used to burn CPU in scrypt. */
export const MAX_PIN_LENGTH = 128;

// scrypt cost parameters. Memory use is ~128 * N * r bytes (16 MiB here),
// which stays under Node's default 32 MiB maxmem.
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;

const LEGACY_SHA256 = /^[0-9a-f]{64}$/i;

/** Validate a candidate PIN. Returns an error message, or null when acceptable. */
export function validatePin(pin: string): string | null {
  if (typeof pin !== "string") return "PIN must be a string.";
  if (pin.length < MIN_PIN_LENGTH) {
    return `PIN must be at least ${MIN_PIN_LENGTH} characters.`;
  }
  if (pin.length > MAX_PIN_LENGTH) {
    return `PIN must be at most ${MAX_PIN_LENGTH} characters.`;
  }
  if (/^(.)\1*$/.test(pin)) return "PIN must not be a single repeated character.";
  return null;
}

function derive(pin: string, salt: Buffer, n: number, r: number, p: number): Buffer {
  // maxmem must exceed 128 * n * r; give it headroom so tuning N later can't throw.
  return crypto.scryptSync(pin, salt, KEYLEN, { N: n, r, p, maxmem: 256 * n * r });
}

/** Hash a PIN for storage. */
export function hashPin(pin: string): string {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = derive(pin, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/** True for the old unsalted SHA-256 format. */
export function isLegacyPinHash(stored: string): boolean {
  return LEGACY_SHA256.test(stored);
}

/** Wrap a legacy unsalted SHA-256 hash in salted scrypt, without needing the PIN. */
export function wrapLegacyHash(legacyHex: string): string {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = derive(legacyHex.toLowerCase(), salt, N, R, P);
  return `scrypt-sha256$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/**
 * Verify a PIN against a stored hash, in constant time for a given format.
 * Returns false (never throws) on a malformed or unrecognized stored hash.
 */
export function verifyPin(pin: string, stored: string): boolean {
  if (!pin || !stored) return false;

  if (LEGACY_SHA256.test(stored)) {
    const legacy = crypto.createHash("sha256").update(pin).digest("hex");
    return timingSafeEqualStr(legacy, stored);
  }

  const parts = stored.split("$");
  if (parts.length !== 6) return false;
  let input: string;
  if (parts[0] === "scrypt") input = pin;
  else if (parts[0] === "scrypt-sha256") input = crypto.createHash("sha256").update(pin).digest("hex");
  else return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // Refuse absurd parameters from a tampered row rather than allocating on them.
  if (n < 2 || n > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, "base64");
    expected = Buffer.from(parts[5]!, "base64");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = crypto.scryptSync(input, salt, expected.length, { N: n, r, p, maxmem: 256 * n * r });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** True when a stored hash uses an outdated scheme and should be re-hashed. */
export function needsRehash(stored: string): boolean {
  if (!stored) return true;
  if (LEGACY_SHA256.test(stored)) return true;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return true;
  return Number(parts[1]) !== N || Number(parts[2]) !== R || Number(parts[3]) !== P;
}

/**
 * Burn roughly the same CPU as a real verification. Called when the account
 * doesn't exist so response time doesn't reveal whether a username is
 * registered.
 */
export function dummyVerify(): void {
  try {
    derive("dummy", Buffer.alloc(SALT_BYTES), N, R, P);
  } catch {
    // best-effort timing equalization only
  }
}

/** Constant-time comparison of two equal-length strings. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
