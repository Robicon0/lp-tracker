"use client";

import { useState, useEffect } from "react";
import type { ActivityEvent } from "../api/aerodrome/activity/route";

export type { ActivityEvent };

export interface PositionActivityData {
  events: ActivityEvent[];
  netInvested0: number;
  netInvested1: number;
  totalFees0: number;
  totalFees1: number;
}

interface CacheEntry {
  data: PositionActivityData;
  fetchedAt: number;  // ms timestamp
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// v3: route now resolves historical sqrtPrice for deposits/withdrawals
// too (not just fee claims).
function cacheKey(positionId: string) {
  return `aero-activity-v3-${positionId}`;
}

function readCache(positionId: string): PositionActivityData | null {
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

function writeCache(positionId: string, data: PositionActivityData) {
  try {
    const entry: CacheEntry = { data, fetchedAt: Date.now() };
    localStorage.setItem(cacheKey(positionId), JSON.stringify(entry));
  } catch {
    // Quota exceeded — ignore
  }
}

export function usePositionActivity(
  positionId: string | null,   // null = skip
  token0Decimals: number,
  token1Decimals: number,
  token0Address?: string,
  token1Address?: string,
  price0?: number,
  price1?: number,
  tickLower?: number | null,
  tickUpper?: number | null,
) {
  const [data, setData] = useState<PositionActivityData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!positionId) return;

    // Try cache first
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
    if (tickLower != null) params.set('tickLower', String(tickLower));
    if (tickUpper != null) params.set('tickUpper', String(tickUpper));

    fetch(`/api/aerodrome/activity?${params.toString()}`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (json.error) {
          setError(json.error);
          return;
        }
        const result = json as PositionActivityData;
        writeCache(positionId, result);
        setData(result);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => { cancelled = true; };
  }, [positionId, token0Decimals, token1Decimals, token0Address, token1Address, price0, price1, tickLower, tickUpper]);

  return { data, isLoading, error };
}
