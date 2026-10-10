// Client-side wrapper for vfat Sickle resolution.
//
// Which Sickles a wallet owns is an OWNERSHIP read (Methodology rule (e)): a
// failed lookup is never "this wallet has no Sickle". It never blanks the
// dashboard either — the wallet's own positions load from separate queries —
// but a lookup that could not be read is reported through the truncation
// channel, so the banner names it and the totals carry `≈`.
import { applyTruncationNotices, lookupFailureNotice } from './enumerationTruncation';

export interface SickleRef {
  chain: string;
  address: string;
}

const NOTICE_SOURCE = 'vfat';
const NOTICE_SCOPE = 'vfat positions';

/**
 * Resolve an EOA's deployed vfat Sickle sub-accounts.
 *
 * Returns [] for the overwhelmingly common case of a non-vfat user. A failed
 * request THROWS (the query keeps its last good answer and retries); an answer
 * with `complete: false` (one chain's lookup failed) returns the Sickles that
 * were found. Both leave a notice; a complete answer clears it.
 */
export async function fetchVfatSickles(owner: string): Promise<SickleRef[]> {
  if (!owner) return [];
  try {
    const res = await fetch(`/api/vfat/sickles?owner=${encodeURIComponent(owner)}`);
    if (!res.ok) throw new Error(`vfat sickle lookup failed: HTTP ${res.status}`);
    const data = await res.json();
    const sickles = Array.isArray(data?.sickles) ? (data.sickles as SickleRef[]) : [];
    applyTruncationNotices(NOTICE_SOURCE, owner, data?.complete === false ? [lookupFailureNotice(NOTICE_SCOPE)] : undefined);
    return sickles;
  } catch (err) {
    applyTruncationNotices(NOTICE_SOURCE, owner, [lookupFailureNotice(NOTICE_SCOPE)]);
    throw err;
  }
}
