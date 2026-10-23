import { describe, it, expect } from "vitest";
import crypto from "crypto";
import {
  hashPin,
  verifyPin,
  needsRehash,
  validatePin,
  isLegacyPinHash,
  wrapLegacyHash,
  MIN_PIN_LENGTH,
  MAX_PIN_LENGTH,
} from "../pin";
import { lockoutSeconds, BASE_LOCKOUT_SECONDS, MAX_LOCKOUT_SECONDS } from "../rate-limit";

describe("validatePin", () => {
  it("rejects a PIN shorter than the minimum", () => {
    expect(validatePin("1".repeat(MIN_PIN_LENGTH - 1))).toMatch(/at least/);
  });

  it("accepts a PIN at exactly the minimum length", () => {
    expect(validatePin("135790".slice(0, MIN_PIN_LENGTH))).toBeNull();
  });

  it("rejects an over-long PIN", () => {
    expect(validatePin("a".repeat(MAX_PIN_LENGTH + 1))).toMatch(/at most/);
  });

  it("rejects a single repeated character", () => {
    expect(validatePin("111111")).toMatch(/repeated/);
  });

  it("rejects an empty PIN", () => {
    expect(validatePin("")).not.toBeNull();
  });
});

describe("hashPin / verifyPin", () => {
  it("verifies a correct PIN", () => {
    const stored = hashPin("correct-horse");
    expect(verifyPin("correct-horse", stored)).toBe(true);
  });

  it("rejects an incorrect PIN", () => {
    const stored = hashPin("correct-horse");
    expect(verifyPin("correct-horsf", stored)).toBe(false);
  });

  it("salts — the same PIN hashes differently every time", () => {
    expect(hashPin("123456")).not.toBe(hashPin("123456"));
  });

  it("produces the documented scrypt format", () => {
    expect(hashPin("123456")).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  });

  it("still verifies a legacy unsalted sha256 hash", () => {
    const legacy = crypto.createHash("sha256").update("123456").digest("hex");
    expect(verifyPin("123456", legacy)).toBe(true);
    expect(verifyPin("654321", legacy)).toBe(false);
  });

  it("returns false rather than throwing on a malformed stored hash", () => {
    for (const bad of ["", "scrypt$", "scrypt$a$b$c$d$e", "not-a-hash", "scrypt$16384$8$1$$"]) {
      expect(verifyPin("123456", bad)).toBe(false);
    }
  });

  it("refuses absurd scrypt parameters from a tampered row", () => {
    expect(verifyPin("123456", "scrypt$99999999$8$1$c2FsdA==$aGFzaA==")).toBe(false);
  });

  it("returns false for an empty PIN", () => {
    expect(verifyPin("", hashPin("123456"))).toBe(false);
  });
});

describe("wrapLegacyHash", () => {
  const legacy = crypto.createHash("sha256").update("123456").digest("hex");

  it("recognizes only the legacy format", () => {
    expect(isLegacyPinHash(legacy)).toBe(true);
    expect(isLegacyPinHash(hashPin("123456"))).toBe(false);
    expect(isLegacyPinHash(wrapLegacyHash(legacy))).toBe(false);
  });

  it("wraps a legacy hash so the same PIN still verifies, and no other", () => {
    const wrapped = wrapLegacyHash(legacy);
    expect(wrapped).toMatch(/^scrypt-sha256\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(verifyPin("123456", wrapped)).toBe(true);
    expect(verifyPin("654321", wrapped)).toBe(false);
  });

  it("matches however the legacy hex was cased", () => {
    expect(verifyPin("123456", wrapLegacyHash(legacy.toUpperCase()))).toBe(true);
  });

  it("is salted: wrapping the same hash twice gives different values", () => {
    expect(wrapLegacyHash(legacy)).not.toBe(wrapLegacyHash(legacy));
  });

  it("is re-hashed plainly at the next login", () => {
    expect(needsRehash(wrapLegacyHash(legacy))).toBe(true);
  });
});

describe("needsRehash", () => {
  it("flags a legacy sha256 hash for upgrade", () => {
    const legacy = crypto.createHash("sha256").update("123456").digest("hex");
    expect(needsRehash(legacy)).toBe(true);
  });

  it("does not flag a current scrypt hash", () => {
    expect(needsRehash(hashPin("123456"))).toBe(false);
  });

  it("flags a hash with outdated cost parameters", () => {
    expect(needsRehash("scrypt$1024$8$1$c2FsdA==$aGFzaA==")).toBe(true);
  });

  it("flags an empty or unrecognized hash", () => {
    expect(needsRehash("")).toBe(true);
    expect(needsRehash("bogus")).toBe(true);
  });
});

describe("lockoutSeconds", () => {
  it("starts at the base lockout", () => {
    expect(lockoutSeconds(0)).toBe(BASE_LOCKOUT_SECONDS);
  });

  it("doubles for each repeat lockout", () => {
    expect(lockoutSeconds(1)).toBe(BASE_LOCKOUT_SECONDS * 2);
    expect(lockoutSeconds(2)).toBe(BASE_LOCKOUT_SECONDS * 4);
  });

  it("caps at the maximum", () => {
    expect(lockoutSeconds(100)).toBe(MAX_LOCKOUT_SECONDS);
  });

  it("treats a negative count as the first lockout", () => {
    expect(lockoutSeconds(-3)).toBe(BASE_LOCKOUT_SECONDS);
  });
});
