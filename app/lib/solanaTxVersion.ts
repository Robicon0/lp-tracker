// Solana transaction versions the engine reads (standing rule (j)).
//
// `getTransaction` returns a transaction only when its version is at or below
// `maxSupportedTransactionVersion`; above it the node answers error -32015
// ("Transaction version (N) is not supported by the requesting client") and
// sends no transaction. Asking with 0 (as every caller did until 2026-10-14)
// made each version-1 transaction (first seen 2026-09-19) unreadable, and the
// callers then skipped it as though it were not there.
//
// The number is the highest version whose jsonParsed shape the engine has been
// checked against, NOT "as high as the node allows": a version the engine has
// not been checked against must come back unreadable and be reported, never be
// parsed on a guess. Measured 2026-10-14 on Alchemy, Helius and the public
// endpoint: all three return version-1 transactions at 1, with the same
// instruction, inner-instruction, token-balance and log fields as version 0.
export const SOLANA_MAX_TX_VERSION = 1;

/** Options for a jsonParsed `getTransaction` at the highest version the engine reads. */
export const SOLANA_GET_TX_OPTIONS = { encoding: 'jsonParsed', maxSupportedTransactionVersion: SOLANA_MAX_TX_VERSION } as const;

const UNSUPPORTED_VERSION_CODE = -32015;

/** True for the node's "transaction version not supported" answer. */
export function isUnsupportedTxVersion(error: { code?: number; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === UNSUPPORTED_VERSION_CODE || /Transaction version \(\d+\) is not supported/i.test(String(error.message ?? ''));
}

/** Short cause for an unreadable transaction, for the stored marker and the log. */
export function unreadableCause(error: { code?: number; message?: string } | null | undefined): string {
  if (!error) return 'not-returned';
  if (isUnsupportedTxVersion(error)) {
    const v = /version \((\d+)\)/i.exec(String(error.message ?? ''))?.[1];
    return v ? `version-${v}` : 'version';
  }
  return `error${error.code != null ? `:${error.code}` : ''}`;
}
