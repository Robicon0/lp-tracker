"use client";

import { useState, useEffect } from "react";
import type { ActivityEvent } from "../api/orca/activity/route";

export type { ActivityEvent };

export interface OrcaActivityData {
  events: ActivityEvent[];
  netInvested0: number;
  netInvested1: number;
  totalFees0: number;
  totalFees1: number;
}

interface CacheEntry {
  data: OrcaActivityData;
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function cacheKey(positionId: string) {
  return `orca-activity-v2-${positionId}`;
}

function readCache(positionId: string): OrcaActivityData | null {
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

function writeCache(positionId: string, data: OrcaActivityData) {
  try {
    localStorage.setItem(cacheKey(positionId), JSON.stringify({ data, fetchedAt: Date.now() }));
  } catch {
    // Quota exceeded — ignore
  }
}

export function useOrcaActivity(
  positionId: string | null, // Orca positionPDA (without 'orca-' prefix); null = skip
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
  const [data, setData] = useState<OrcaActivityData | null>(null);
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

    fetch(`/api/orca/activity?${params.toString()}`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (json.error) { setError(json.error); return; }
        const result = json as OrcaActivityData;
        writeCache(positionId, result);
        setData(result);
      })
      .catch((err) => { if (!cancelled) setError(String(err)); })
      .finally(() => { if (!cancelled) setIsLoading(false); });

    return () => { cancelled = true; };
  }, [positionId, decimalsA, decimalsB, mintA, mintB, priceA, priceB, account, tickLower, tickUpper]);

  return { data, isLoading, error };
}
