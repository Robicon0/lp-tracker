"use client";

import { useState, useEffect } from "react";
import type { ActivityEvent } from "../api/pancakeswap/activity/route";

export type { ActivityEvent };

export interface PancakeSwapActivityData {
  events: ActivityEvent[];
  netInvested0: number;
  netInvested1: number;
  totalFees0: number;
  totalFees1: number;
}

interface CacheEntry {
  data: PancakeSwapActivityData;
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

// v3: route now resolves historical sqrtPrice for deposits/withdrawals
// too (not just fee claims).
function cacheKey(tokenId: string) {
  return `cake-activity-v3-${tokenId}`;
}

function readCache(tokenId: string): PancakeSwapActivityData | null {
  try {
    const raw = localStorage.getItem(cacheKey(tokenId));
    if (!raw) return null;
    const entry: CacheEntry = JSON.parse(raw);
    if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return null;
    return entry.data;
  } catch {
    return null;
  }
}

function writeCache(tokenId: string, data: PancakeSwapActivityData) {
  try {
    const entry: CacheEntry = { data, fetchedAt: Date.now() };
    localStorage.setItem(cacheKey(tokenId), JSON.stringify(entry));
  } catch {
    // Quota exceeded — ignore
  }
}

// tokenId is the bare numeric NFT id (no protocol prefix). Pass null to skip.
export function usePancakeSwapActivity(
  tokenId: string | null,
  token0Decimals: number,
  token1Decimals: number,
  token0Address?: string,
  token1Address?: string,
  price0?: number,
  price1?: number,
  tickLower?: number | null,
  tickUpper?: number | null,
) {
  const [data, setData] = useState<PancakeSwapActivityData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tokenId) return;

    const cached = readCache(tokenId);
    if (cached) {
      setData(cached);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    const params = new URLSearchParams({
      positionId: tokenId,
      t0d: String(token0Decimals),
      t1d: String(token1Decimals),
    });
    if (token0Address) params.set('token0', token0Address);
    if (token1Address) params.set('token1', token1Address);
    if (price0 != null) params.set('p0', String(price0));
    if (price1 != null) params.set('p1', String(price1));
    if (tickLower != null) params.set('tickLower', String(tickLower));
    if (tickUpper != null) params.set('tickUpper', String(tickUpper));

    fetch(`/api/pancakeswap/activity?${params.toString()}`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (json.error) { setError(json.error); return; }
        const result = json as PancakeSwapActivityData;
        writeCache(tokenId, result);
        setData(result);
      })
      .catch((err) => { if (!cancelled) setError(String(err)); })
      .finally(() => { if (!cancelled) setIsLoading(false); });

    return () => { cancelled = true; };
  }, [tokenId, token0Decimals, token1Decimals, token0Address, token1Address, price0, price1, tickLower, tickUpper]);

  return { data, isLoading, error };
}
