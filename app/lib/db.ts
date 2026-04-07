// Vercel Postgres connection helper.
//
// Gracefully degrades when POSTGRES_URL is not configured (e.g. local dev
// without a provisioned database). Routes that import this should check
// `isDbConfigured()` before issuing queries — when false, they should
// return an empty/“not configured” response instead of throwing.

import { sql, createClient } from "@vercel/postgres";

export function isDbConfigured(): boolean {
  return !!(process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING);
}

// Re-export the pooled `sql` template for convenience.
export { sql };

// One-shot client for migrations / setup scripts.
export function dbClient() {
  return createClient();
}
