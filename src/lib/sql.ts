/**
 * Postgres access through Neon's serverless driver.
 *
 * Replaces `@vercel/postgres`, which is deprecated and was a wrapper around the
 * same driver. Keeps its call shape — `const { rows } = await sql<T>\`...\`` — so
 * call sites don't change, and its connection string, `POSTGRES_URL`, which the
 * Vercel / Neon integration provides.
 *
 * The driver is created on first use, not at import: Next.js imports route
 * modules while building, when no connection string exists.
 */

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

let query: NeonQueryFunction<false, true> | null = null;

function connect(): NeonQueryFunction<false, true> {
  const url = process.env.POSTGRES_URL;
  if (!url) throw new Error("Missing required environment variable: POSTGRES_URL");
  return neon(url, { fullResults: true });
}

/** Tagged-template query. Values are sent as parameters, never interpolated. */
export async function sql<T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<QueryResult<T>> {
  query ??= connect();
  const result = await query(strings, ...values);
  return { rows: result.rows as T[], rowCount: result.rowCount ?? result.rows.length };
}
