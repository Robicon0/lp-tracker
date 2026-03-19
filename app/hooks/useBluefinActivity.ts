"use client";

import { useState, useEffect } from "react";
import type { ActivityEvent } from "../api/bluefin/activity/route";

export type { ActivityEvent };

export interface BluefinActivityData {
  events: ActivityEvent[];
  netInvested0: number;
  netInvested1: number;
  totalFees0: number;
  totalFees1: number;
}

interface CacheEntry {
  data: BluefinActivityData;
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function cacheKey(positionId: string) {
  return `bluefin-activity-${positionId}`;
}

function readCache(positionId: string): BluefinActivityData | null {
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

function writeCache(positionId: string, data: BluefinActivityData) {
  try {
    localStorage.setItem(cacheKey(positionId), JSON.stringify({ data, fetchedAt: Date.now() }));
  } catch {
    // Quota exceeded — ignore
  }
}

export function useBluefinActivity(
  positionId: string | null, // raw Sui object ID (without bluefin- prefix); null = skip
  decimalsA: number,
  decimalsB: number,
  coinTypeA?: string,
  coinTypeB?: string,
  priceA?: number,
  priceB?: number,
  account?: string,
) {
  const [data, setData] = useState<BluefinActivityData | null>(null);
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
      decimalsA: String(decimalsA),
      decimalsB: String(decimalsB),
    });
    if (coinTypeA) params.set('coinTypeA', coinTypeA);
    if (coinTypeB) params.set('coinTypeB', coinTypeB);
    if (priceA != null) params.set('priceA', String(priceA));
    if (priceB != null) params.set('priceB', String(priceB));

    fetch(`/api/bluefin/activity?${params.toString()}`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (json.error) {
          setError(json.error);
          return;
        }
        const result = json as BluefinActivityData;
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
  }, [positionId, decimalsA, decimalsB, coinTypeA, coinTypeB, priceA, priceB, account]);

  return { data, isLoading, error };
}
