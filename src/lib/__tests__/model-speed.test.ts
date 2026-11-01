import { describe, it, expect } from "vitest";
import { MODEL_SPEED, speedRow, STALE_AFTER_DAYS, type ModelSpeedRow } from "../model-speed";
import { PROVIDERS } from "../providers";

/**
 * The measured table behind the faster-model hint. A row only counts while its
 * fast model is still one the app lists for that provider, and is recent.
 */

const row: ModelSpeedRow = {
  provider: "openai", fastModel: "gpt-4.1", fastMeanMs: 5000, coverageFast: 0.93,
  slowModel: "gpt-6.1-terra", slowMeanMs: 13000, coverageSlow: 1, sources: 12, measuredOn: "2026-11-01",
};

describe("MODEL_SPEED", () => {
  // protects: the hint only suggests a model the app lists for that provider; fails_when: PROVIDERS drops it and the table isn't re-measured; no_claim: the numbers are current
  it("suggests only listed models", () => {
    for (const r of MODEL_SPEED) expect(PROVIDERS[r.provider].models).toContain(r.fastModel);
  });

  // protects: rows hold usable numbers; fails_when: a row has a zero time or a coverage outside 0..1; no_claim: none
  it("holds sane numbers", () => {
    for (const r of MODEL_SPEED) {
      expect(r.fastMeanMs).toBeGreaterThan(0);
      for (const c of [r.coverageFast, r.coverageSlow]) expect(c >= 0 && c <= 1).toBe(true);
      expect(r.measuredOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("speedRow", () => {
  const day = (d: string) => new Date(`${d}T12:00:00Z`);

  // protects: a fresh row is used; fails_when: it is ignored; no_claim: none
  it("returns the provider's row while it is fresh", () => {
    expect(speedRow("openai", day("2026-11-20"), [row])).toEqual(row);
  });

  // protects: an old measurement is never quoted; fails_when: a row older than the limit is returned; no_claim: none
  it(`drops a row older than ${STALE_AFTER_DAYS} days`, () => {
    expect(speedRow("openai", day("2027-02-15"), [row])).toBeNull();
  });

  // protects: providers we never measured get no hint; fails_when: another provider's row is used; no_claim: none
  it("returns null for a provider with no row", () => {
    expect(speedRow("anthropic", day("2026-11-20"), [row])).toBeNull();
  });

  // protects: a row for a model the app no longer lists is ignored; fails_when: it is used; no_claim: none
  it("ignores a row whose model is no longer listed", () => {
    expect(speedRow("openai", day("2026-11-20"), [{ ...row, fastModel: "gpt-3.5-turbo" }])).toBeNull();
  });
});
