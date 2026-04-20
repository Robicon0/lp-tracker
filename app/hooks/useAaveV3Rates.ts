"use client";

import { useState, useEffect, useRef } from "react";
import type { TokenItem } from "./useWalletTokens";

// AAVE V3 live rates per-token (keyed by lowercase contract address).
// Wraps /api/aave-v3/rates — groups tokens by chain, fans out one request per
// chain that has aTokens or debt tokens in the wallet set, then merges results.

export interface AaveRate {
  supplyApy: number;
  borrowApy: number;
}

export type AaveV3RatesMap = Record<string, AaveRate>;
export type AaveV3PricesMap = Record<string, number>;

const SUPPORTED_CHAINS = new Set(["Ethereum", "Arbitrum", "Optimism", "Polygon", "Base"]);

export function useAaveV3Rates(tokens: TokenItem[]): {
  rates: AaveV3RatesMap;
  prices: AaveV3PricesMap;
  isLoading: boolean;
} {
  const [rates, setRates] = useState<AaveV3RatesMap>({});
  const [prices, setPrices] = useState<AaveV3PricesMap>({});
  const [isLoading, setIsLoading] = useState(false);
  const fetchedKeyRef = useRef<string | null>(null);

  // Build a deterministic key: every (chain, lowercase contract address) pair
  // for AAVE aToken / debt token items on supported chains.
  const targets: Record<string, string[]> = {};
  for (const t of tokens) {
    if (!SUPPORTED_CHAINS.has(t.chain)) continue;
    if (!t.isLending && !t.isDebt) continue;
    if (!t.contractAddress || !/^0x[0-9a-fA-F]{40}$/.test(t.contractAddress)) continue;
    const bucket = (targets[t.chain] = targets[t.chain] ?? []);
    const addr = t.contractAddress.toLowerCase();
    if (!bucket.includes(addr)) bucket.push(addr);
  }
  const fetchKey = Object.keys(targets).sort()
    .map((chain) => `${chain}:${targets[chain].slice().sort().join(",")}`)
    .join("|") || null;

  useEffect(() => {
    if (!fetchKey) {
      if (fetchedKeyRef.current !== null) {
        fetchedKeyRef.current = null;
        setRates({});
      }
      return;
    }
    if (fetchedKeyRef.current === fetchKey) return;
    fetchedKeyRef.current = fetchKey;

    let cancelled = false;
    setIsLoading(true);

    (async () => {
      try {
        const entries = Object.entries(targets);
        const results = await Promise.allSettled(
          entries.map(async ([chain, addrs]) => {
            const url = `/api/aave-v3/rates?chain=${encodeURIComponent(chain)}&tokens=${addrs.join(",")}`;
            const res = await fetch(url).then(
              (r) => r.json() as Promise<{ rates?: AaveV3RatesMap; prices?: AaveV3PricesMap }>,
            );
            return { rates: res.rates ?? {}, prices: res.prices ?? {} };
          }),
        );
        if (cancelled) return;
        const mergedRates: AaveV3RatesMap = {};
        const mergedPrices: AaveV3PricesMap = {};
        for (const r of results) {
          if (r.status !== "fulfilled") continue;
          for (const [addr, rate] of Object.entries(r.value.rates)) {
            mergedRates[addr.toLowerCase()] = rate;
          }
          for (const [addr, usd] of Object.entries(r.value.prices)) {
            if (typeof usd === "number" && usd > 0) mergedPrices[addr.toLowerCase()] = usd;
          }
        }
        setRates(mergedRates);
        setPrices(mergedPrices);
      } catch (err) {
        console.error("[useAaveV3Rates] fetch failed:", err);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchKey]);

  return { rates, prices, isLoading };
}
