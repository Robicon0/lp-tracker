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

function cacheKey(positionId: string) {
  return `aero-activity-${positionId}`;
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

    fetch(`/api/aerodrome/activity?positionId=${positionId}&t0d=${token0Decimals}&t1d=${token1Decimals}`)
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
  }, [positionId, token0Decimals, token1Decimals]);

  return { data, isLoading, error };
}
