// A block timestamp that could not be read is asked for again.
//
// Every EVM activity route dates its events by `eth_getBlockByNumber`. When
// that call is throttled the route used to keep `0` for the block, and the
// event left the route dated 1970: counted in every lifetime total, outside
// every time window. Measured on production 2026-10-11: the three Uniswap V3
// claims of one wallet (168.09) and nine Aerodrome claims came back undated on
// an ordinary page load, so the by-protocol panel showed 84.73, 120.80 or no
// Uniswap row at all while the lifetime figure stayed whole.
//
// `fillMissingTimestamps` re-asks only for the blocks still at 0, after a short
// pause, and never overwrites a timestamp it already has. An event that is
// still undated afterwards is handled on the page (analytics feeIncome): it
// takes its date from the other scan's copy of the same claim, and failing
// that the panel says how many claims it could not date.
const RETRY_PAUSES_MS = [400, 1200];

export async function fillMissingTimestamps(
  timestamps: Record<number, number>,
  blockNumbers: number[],
  refetch: (missing: number[]) => Promise<Record<number, number>>,
): Promise<Record<number, number>> {
  for (const pause of RETRY_PAUSES_MS) {
    const missing = [...new Set(blockNumbers)].filter((b) => !(timestamps[b] > 0));
    if (missing.length === 0) break;
    await new Promise((r) => setTimeout(r, pause));
    try {
      const again = await refetch(missing);
      for (const b of missing) if (again[b] > 0) timestamps[b] = again[b];
    } catch { /* still undated; the page reports it */ }
  }
  return timestamps;
}
