"use client";

import { useState, useEffect } from "react";
import type { ActivityEvent } from "../api/uniswap/activity/route";

export type { ActivityEvent };

export interface UniswapActivityData {
  events: ActivityEvent[];
  netInvested0: number;
  netInvested1: number;
  totalFees0: number;
  totalFees1: number;
}

interface CacheEntry {
  data: UniswapActivityData;
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

function cacheKey(chain: string, tokenId: string) {
  return `uni-activity-${chain}-${tokenId}`;
}

function readCache(chain: string, tokenId: string): UniswapActivityData | null {
  try {
    const raw = localStorage.getItem(cacheKey(chain, tokenId));
    if (!raw) return null;
    const entry: CacheEntry = JSON.parse(raw);
    if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return null;
    return entry.data;
  } catch {
    return null;
  }
}

function writeCache(chain: string, tokenId: string, data: UniswapActivityData) {
  try {
    const entry: CacheEntry = { data, fetchedAt: Date.now() };
    localStorage.setItem(cacheKey(chain, tokenId), JSON.stringify(entry));
  } catch {
    // Quota exceeded — ignore
  }
}

// positionId format: uni3-{chainKey}-{tokenId} (e.g. uni3-ethereum-12345)
// Pass null to skip fetching.
export function useUniswapActivity(
  positionId: string | null,
  token0Decimals: number,
  token1Decimals: number,
  token0Address?: string,
  token1Address?: string,
  price0?: number,
  price1?: number,
) {
  const [data, setData] = useState<UniswapActivityData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!positionId) return;

    // Parse "uni3-{chain}-{tokenId}" — chain may contain no hyphens
    // Format is always: uni3-<chain>-<numeric tokenId>
    const match = positionId.match(/^uni3-([a-z]+)-(\d+)$/);
    if (!match) return;
    const chain   = match[1];
    const tokenId = match[2];

    const cached = readCache(chain, tokenId);
    if (cached) {
      setData(cached);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    const params = new URLSearchParams({
      chain,
      tokenId,
      t0d: String(token0Decimals),
      t1d: String(token1Decimals),
    });
    if (token0Address) params.set('token0', token0Address);
    if (token1Address) params.set('token1', token1Address);
    if (price0 != null) params.set('p0', String(price0));
    if (price1 != null) params.set('p1', String(price1));

    fetch(`/api/uniswap/activity?${params.toString()}`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (json.error) { setError(json.error); return; }
        const result = json as UniswapActivityData;
        writeCache(chain, tokenId, result);
        setData(result);
      })
      .catch((err) => { if (!cancelled) setError(String(err)); })
      .finally(() => { if (!cancelled) setIsLoading(false); });

    return () => { cancelled = true; };
  }, [positionId, token0Decimals, token1Decimals, token0Address, token1Address, price0, price1]);

  return { data, isLoading, error };
}
