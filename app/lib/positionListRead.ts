// A failed read of what a wallet OWNS is never "owns nothing".
//
// Every position route starts by asking the chain which positions the wallet
// holds (owned objects on Sui, token accounts on Solana, `balanceOf` on EVM).
// When that read failed, the helpers fell back to an empty list or to 0 and the
// route answered a well-formed `{ positions: [], count: 0 }` with HTTP 200 —
// indistinguishable from a wallet with no positions. Measured on production
// 2026-10-09: the first Cetus call after a deploy returned no positions for a
// wallet holding $11,358, with nothing logged.
//
// The ownership read now THROWS this error. A route with one source lets it
// reach its catch block and answers a non-200 (the client wrapper throws and
// the page keeps the last good rows and names the source). A route that reads
// several chains or managers keeps the ones that answered and reports the
// failed one through the truncation channel (`lookupFailureNotice`).
export class PositionListReadError extends Error {
  constructor(public readonly source: string, public readonly what: string) {
    super(`${source}: ${what} could not be read`);
    this.name = 'PositionListReadError';
  }
}

/** Log line for a failed ownership read. Never include an RPC URL (it can carry a key). */
export function logPositionListReadFailure(source: string, account: string, err: unknown): void {
  const reason = err instanceof Error ? err.message : String(err);
  console.error(`[positions] ${source}: ownership read failed for ${account} — answering an error, not an empty list. ${reason.slice(0, 200)}`);
}
