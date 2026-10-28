import crypto from "crypto";
import type { NextRequest } from "next/server";
import { env } from "./env";

/** Constant-time string comparison, so the secret can't be recovered byte-by-byte. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** True when the request carries the admin secret in the x-admin-secret header. */
export function adminAuthorized(req: NextRequest): boolean {
  return timingSafeEqualStr(req.headers.get("x-admin-secret") ?? "", env.adminSecret);
}
