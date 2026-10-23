import { KNOWN_ORIGINS } from "./origin";

/**
 * Whether this build serves the hosted service at xkg.xmu.sh.
 *
 * The Privacy Policy and Terms name that service's operator, so a self-hosted
 * copy must neither show them as its own nor ask users to accept them.
 * Development builds count as hosted, so the documents can be previewed.
 *
 * Reads `process.env.NEXT_PUBLIC_APP_URL` literally, not through lib/env, so
 * Next.js inlines it into client components too (the sign-in page uses this).
 */
export function isHostedInstance(): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  try {
    return KNOWN_ORIGINS.includes(new URL(process.env.NEXT_PUBLIC_APP_URL ?? "").origin);
  } catch {
    return false;
  }
}
