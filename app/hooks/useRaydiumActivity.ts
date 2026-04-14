"use client";

import { useState, useEffect } from "react";
import type { ActivityEvent } from "../api/raydium/activity/route";

export type { ActivityEvent };

export interface RaydiumActivityData {
  events: ActivityEvent[];
  netInvested0: number;
  netInvested1: number;
  totalFees0: number;
  totalFees1: number;
}

interface CacheEntry {
  data: RaydiumActivityData;
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function cacheKey(positionId: string) {
  return `raydium-activity-v2-${positionId}`;
}

function readCache(positionId: string): RaydiumActivityData | null {
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

function writeCache(positionId: string, data: RaydiumActivityData) {
  try {
    localStorage.setItem(cacheKey(positionId), JSON.stringify({ data, fetchedAt: Date.now() }));
  } catch {
    // Quota exceeded — ignore
  }
}

export function useRaydiumActivity(
  positionId: string | null, // Raydium position state account pubkey (without 'ray-' prefix); null = skip
  decimalsA: number,
  decimalsB: number,
  mintA?: string,
  mintB?: string,
  priceA?: number,
  priceB?: number,
  account?: string,
  tickLower?: number | null,
  tickUpper?: number | null,
) {
  const [data, setData] = useState<RaydiumActivityData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!positionId || !account) return;

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
      account,
      t0d: String(decimalsA),
      t1d: String(decimalsB),
    });
    if (mintA) params.set('mintA', mintA);
    if (mintB) params.set('mintB', mintB);
    if (priceA != null) params.set('priceA', String(priceA));
    if (priceB != null) params.set('priceB', String(priceB));
    if (tickLower != null) params.set('tickLower', String(tickLower));
    if (tickUpper != null) params.set('tickUpper', String(tickUpper));

    fetch(`/api/raydium/activity?${params.toString()}`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (json.error) { setError(json.error); return; }
        const result = json as RaydiumActivityData;
        writeCache(positionId, result);
        setData(result);
      })
      .catch((err) => { if (!cancelled) setError(String(err)); })
      .finally(() => { if (!cancelled) setIsLoading(false); });

    return () => { cancelled = true; };
  }, [positionId, decimalsA, decimalsB, mintA, mintB, priceA, priceB, account, tickLower, tickUpper]);

  return { data, isLoading, error };
}
