"use client";

import { useState, useEffect } from "react";
import type { ActivityEvent } from "../api/velodrome/activity/route";

export type { ActivityEvent };

export interface VelodromeActivityData {
  events: ActivityEvent[];
  netInvested0: number;
  netInvested1: number;
  totalFees0: number;
  totalFees1: number;
}

interface CacheEntry {
  data: VelodromeActivityData;
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

function cacheKey(positionId: string) {
  return `velo-activity-${positionId}`;
}

function readCache(positionId: string): VelodromeActivityData | null {
  try {
    const raw = localStorage.getItem(cacheKey(positionId));
    if (!raw) return null;
    const entry: CacheEntry = JSON.parse(raw);
    if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return null;
    return entry.data;
  } catch {
    return null;
  }
}

function writeCache(positionId: string, data: VelodromeActivityData) {
  try {
    const entry: CacheEntry = { data, fetchedAt: Date.now() };
    localStorage.setItem(cacheKey(positionId), JSON.stringify(entry));
  } catch {
    // Quota exceeded — ignore
  }
}

// positionId: strip "velo-" prefix from pos.id → numeric Sugar position ID (= NFT tokenId).
// Pass null to skip fetching.
export function useVelodromeActivity(
  positionId: string | null,
  token0Decimals: number,
  token1Decimals: number,
  token0Address?: string,
  token1Address?: string,
  price0?: number,
  price1?: number,
) {
  const [data, setData] = useState<VelodromeActivityData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!positionId) return;

    const cached = readCache(positionId);
    if (cached) {
      setData(cached);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    const params = new URLSearchParams({
      positionId,
      t0d: String(token0Decimals),
      t1d: String(token1Decimals),
    });
    if (token0Address) params.set('token0', token0Address);
    if (token1Address) params.set('token1', token1Address);
    if (price0 != null) params.set('p0', String(price0));
    if (price1 != null) params.set('p1', String(price1));

    fetch(`/api/velodrome/activity?${params.toString()}`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (json.error) { setError(json.error); return; }
        const result = json as VelodromeActivityData;
        writeCache(positionId, result);
        setData(result);
      })
      .catch((err) => { if (!cancelled) setError(String(err)); })
      .finally(() => { if (!cancelled) setIsLoading(false); });

    return () => { cancelled = true; };
  }, [positionId, token0Decimals, token1Decimals, token0Address, token1Address, price0, price1]);

  return { data, isLoading, error };
}
