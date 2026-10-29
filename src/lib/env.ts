/**
 * Validated access to environment variables.
 * Fails fast on missing required vars instead of silent fallbacks.
 */

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const env = {
  /** GitHub OAuth client ID. */
  get githubClientId(): string {
    return required("GITHUB_CLIENT_ID");
  },
  /** GitHub OAuth client secret. */
  get githubClientSecret(): string {
    return required("GITHUB_CLIENT_SECRET");
  },
  /** Secret for signing session cookies. */
  get sessionSecret(): string {
    return required("SESSION_SECRET");
  },
  /** Secret for the operator endpoints: /api/init-db and /api/admin/*. */
  get adminSecret(): string {
    return required("ADMIN_SECRET");
  },
  /** xkg's own TypeSafe key: when set, Jev decides where a capture applies (server-side only). */
  get typesafeApiKey(): string | null {
    return process.env.TYPESAFE_API_KEY || null;
  },
  /** Public app URL — used for OAuth redirects and links. */
  get appUrl(): string {
    return optional("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
  },
  /** Whether the app is running in production. */
  get isProduction(): boolean {
    return process.env.NODE_ENV === "production";
  },
} as const;
