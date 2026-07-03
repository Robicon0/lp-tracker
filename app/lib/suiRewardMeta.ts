// Sprint POSITION-DETAIL — shared reward-token identity + spot pricing for the
// Sui dashboard routes (Cetus / Bluefin / Momentum pending REWARD emissions).
//
// The routes read each position's pending reward amounts from on-chain rewarder
// state (pool rewarders + position checkpoints + tick reward-growth-outside —
// Protocol Correctness Contract invariant (k)) as RAW integers keyed by the
// rewarder's on-chain coin type. This module turns those coin types into
// { symbol, decimals, spot USD price }:
//   - identity via the shared platform resolver (architecture Rule 9 /
//     invariant (i)) — decimals are on-chain truth, never a blind default;
//   - price at CURRENT SPOT through the resilient tiered helper
//     (SPOT-RESILIENCE invariant (j): Tier A stables → $1, Redis LKG on 429) —
//     pending amounts are a current-value display (Rule 2), NOT a fee claim,
//     so spot is the correct domain (Rule 1a is untouched).
// An unresolvable/unpriceable reward keeps its on-chain amount with usd 0 —
// shown, never hidden, never guessed.

import { resolveToken } from './tokenResolver';
import { fetchCachedCoinGeckoPrices } from './priceCache';
import { normalizeSuiType } from './tokenConstants';

export interface RewardTokenMeta {
  symbol: string;
  decimals: number;
  priceUsd: number;
}

export async function resolveSuiRewardTokens(
  coinTypes: string[],
): Promise<Map<string, RewardTokenMeta>> {
  const out = new Map<string, RewardTokenMeta>();
  const unique = [...new Set(coinTypes.filter(Boolean).map((ct) => normalizeSuiType(ct)))];
  if (unique.length === 0) return out;

  const resolved = await Promise.all(unique.map(async (ct) => {
    try {
      const tok = await resolveToken({ chain: 'sui', suiType: ct });
      return { ct, symbol: tok.symbol, decimals: tok.decimals, cgId: tok.cgId };
    } catch {
      return { ct, symbol: ct.split('::').pop() ?? 'REWARD', decimals: 9, cgId: null as string | null };
    }
  }));

  const cgIds = [...new Set(resolved.map((r) => r.cgId).filter((x): x is string => !!x))];
  const prices = cgIds.length > 0 ? await fetchCachedCoinGeckoPrices(cgIds) : {};

  for (const r of resolved) {
    out.set(r.ct, {
      symbol: r.symbol,
      decimals: r.decimals,
      priceUsd: r.cgId ? (prices[r.cgId] ?? 0) : 0,
    });
  }
  return out;
}

// Raw on-chain reward amounts → the position JSON shape (human amount + spot
// USD). Zero-amount entries are dropped (a pool rewarder the position never
// accrued from is not a claimable row).
export function buildPendingRewards(
  raw: Array<{ coinType: string; raw: bigint }>,
  meta: Map<string, RewardTokenMeta>,
): Array<{ symbol: string; coinType: string; amount: number; usd: number }> {
  const out: Array<{ symbol: string; coinType: string; amount: number; usd: number }> = [];
  for (const r of raw) {
    if (r.raw <= 0n) continue;
    const ct = normalizeSuiType(r.coinType);
    const m = meta.get(ct);
    const decimals = m?.decimals ?? 9;
    const amount = Number(r.raw) / 10 ** decimals;
    if (!(amount > 0)) continue;
    out.push({
      symbol: m?.symbol ?? (ct.split('::').pop() ?? 'REWARD'),
      coinType: ct,
      amount: Math.round(amount * 1_000_000) / 1_000_000,
      usd: Math.round(amount * (m?.priceUsd ?? 0) * 100) / 100,
    });
  }
  return out;
}
