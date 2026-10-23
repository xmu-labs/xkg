import { describe, it, expect, afterEach, vi } from "vitest";
import { isHostedInstance } from "../hosted";

/**
 * The Privacy Policy, Terms and the sign-in consent line belong to the hosted
 * service only; a self-hosted production build must not present them.
 */
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isHostedInstance", () => {
  it("is true in production on the hosted address", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://xkg.xmu.sh");
    expect(isHostedInstance()).toBe(true);
  });

  it("is true on the hosted service's older address", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://mnemos-capture.vercel.app");
    expect(isHostedInstance()).toBe(true);
  });

  it("is false for a self-hosted production build", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://kg.example.com");
    expect(isHostedInstance()).toBe(false);
  });

  it("is false in production when the address is missing or invalid", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(isHostedInstance()).toBe(false);
  });

  it("is true in development, so the documents can be previewed", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
    expect(isHostedInstance()).toBe(true);
  });
});
