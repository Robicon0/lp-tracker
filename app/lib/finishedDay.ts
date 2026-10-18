// A historical price for a finished UTC day never changes, so its stored copy
// has no expiry (Oct 19, batch C 1a). CoinGecko's free plan cannot re-fetch a
// date older than 365 days: a copy that expired was a price lost for good, and
// the claim then read "not priced yet" (HyperEVM claims have no other source).
// A price for TODAY may still move, so it keeps the old expiry.

const DAY = 86_400;

/** True when the UTC day containing `timestampSec` ended before now. */
export function isFinishedUtcDay(timestampSec: number, nowMs = Date.now()): boolean {
  if (!Number.isFinite(timestampSec) || timestampSec <= 0) return false;
  const todayStart = Math.floor(nowMs / 1000 / DAY) * DAY;
  return timestampSec < todayStart;
}

/** Store options for a price copy: no expiry for a finished day, else `ttlSeconds`. */
export function priceCopyOpts(timestampSec: number, ttlSeconds: number): { ex: number } | undefined {
  return isFinishedUtcDay(timestampSec) ? undefined : { ex: ttlSeconds };
}
