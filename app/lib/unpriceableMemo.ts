// app/lib/unpriceableMemo.ts
//
// "This position could not be priced" — remembered per browser for 6 hours.
//
// The pricing retry in useLpPnl re-fetches a position whose deposit or
// withdrawal had no price yet, on a ~320 s schedule (12 rounds). For a position
// that can never be priced (a token no price source knows, e.g. the 51 closed
// `TOKEN0 / TOKEN1` positions of contract wallet 0x844e…7c97) every round is
// wasted: about 700-940 requests per analytics load, on every load, before the
// page says "could not be priced".
//
// So once a load has run the whole schedule and a position is still not priced,
// that is remembered here. A later load still fetches the position once (its
// row and its notice need the answer, and a price that has appeared since is
// picked up then), but does not retry it until the memo is 6 hours old. The
// notice is unchanged: the position stays out of the total, counted, `≈`.
//
// Per-viewer browser storage on purpose: it only saves requests, a lost entry
// costs one schedule, and nothing here is a figure. Every access is guarded.

export const UNPRICEABLE_MEMO_MS = 6 * 60 * 60 * 1000;
const PREFIX = 'lp-pnl-unpriceable-v1-';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(s?: StorageLike | null): StorageLike | null {
  if (s !== undefined) return s;
  try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
}

/** True when this position was found unpriceable less than 6 hours ago. */
export function isRememberedUnpriceable(id: string, now = Date.now(), s?: StorageLike | null): boolean {
  const st = storage(s);
  if (!st) return false;
  try {
    const at = Number(st.getItem(PREFIX + id));
    if (!(at > 0)) return false;
    if (now - at < UNPRICEABLE_MEMO_MS && at <= now) return true;
    st.removeItem(PREFIX + id); // expired: re-checked on this load
    return false;
  } catch { return false; }
}

export function rememberUnpriceable(ids: Iterable<string>, now = Date.now(), s?: StorageLike | null): void {
  const st = storage(s);
  if (!st) return;
  for (const id of ids) { try { st.setItem(PREFIX + id, String(now)); } catch { /* storage full or blocked */ } }
}

/** A position that came back priced is forgotten at once. */
export function forgetUnpriceable(ids: Iterable<string>, s?: StorageLike | null): void {
  const st = storage(s);
  if (!st) return;
  for (const id of ids) { try { st.removeItem(PREFIX + id); } catch { /* ignore */ } }
}
