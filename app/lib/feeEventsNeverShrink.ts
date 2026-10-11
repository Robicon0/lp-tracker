// Fee data already on the page never shrinks on a refresh.
//
// A claim is a finalized on-chain event: once a source has returned it, it
// cannot stop existing. So when a later answer from the SAME source has fewer
// events — an empty 200 after a failed enumeration, a scan that came back
// short, a copy that lost its price or its date — that is the source degrading,
// not the history changing, and the page keeps what it had.
//
// Measured on production 2026-10-11: on a 60-second refresh the Uniswap
// wallet-wide scan answered 200 with no events; lifetime Fees Collected read
// 14,322.27 instead of 14,490.36 for about a minute, with no mark.
//
// The rule, per event (identity = type + transaction + log index, or the
// amounts when a route gives no log index):
//   • present before, absent now      → kept (counted in `retained`);
//   • priced before, unpriced now     → the earlier price is kept;
//   • dated before, undated now       → the earlier date is kept;
//   • present in both and whole       → the new copy wins (a re-read may carry
//     a better price basis; that is a real change and it is taken).
// Nothing is ever invented: every value here came from the source itself.
// A different source context (another wallet, another pool) is a different KEY
// at the call site, so retained events never leak between wallets.

export interface NeverShrinkEvent {
  type: string;
  timestamp: number;
  amount0: number;
  amount1: number;
  usdAtTime: number | null;
  txHash?: string;
  logIndex?: number;
}

export function feeEventIdentity(e: NeverShrinkEvent): string {
  if (e.txHash && e.logIndex != null) return `${e.type}::${e.txHash}::${e.logIndex}`;
  if (e.txHash) return `${e.type}::${e.txHash}::${e.amount0}::${e.amount1}`;
  return `${e.type}::ts${e.timestamp}::${e.amount0}::${e.amount1}`;
}

export interface NeverShrinkResult<T> {
  events: T[];
  /** Events the new answer no longer had, kept from the earlier one. */
  retained: number;
  /** Events whose price or date was kept from the earlier copy. */
  repaired: number;
}

export function mergeNeverShrink<T extends NeverShrinkEvent>(
  previous: ReadonlyArray<T> | undefined,
  fresh: ReadonlyArray<T>,
): NeverShrinkResult<T> {
  if (!previous || previous.length === 0) return { events: [...fresh], retained: 0, repaired: 0 };
  const before = new Map<string, T>();
  for (const e of previous) before.set(feeEventIdentity(e), e);

  const out: T[] = [];
  const seen = new Set<string>();
  let repaired = 0;
  for (const e of fresh) {
    const id = feeEventIdentity(e);
    seen.add(id);
    const old = before.get(id);
    if (!old) { out.push(e); continue; }
    const lostPrice = e.usdAtTime == null && old.usdAtTime != null;
    const lostDate = !(e.timestamp > 0) && old.timestamp > 0;
    if (!lostPrice && !lostDate) { out.push(e); continue; }
    repaired += 1;
    out.push({
      ...e,
      ...(lostPrice ? { usdAtTime: old.usdAtTime } : {}),
      ...(lostDate ? { timestamp: old.timestamp } : {}),
    });
  }
  let retained = 0;
  for (const [id, old] of before) {
    if (seen.has(id)) continue;
    retained += 1;
    out.push(old);
  }
  return { events: out, retained, repaired };
}
