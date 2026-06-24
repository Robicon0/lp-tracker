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
  // v3: Bluefin activity route now values fee_claim / reward_claim against
  // historical SUI price at the claim's date instead of today's spot.
  // v3 → v4 (Sprint NEW): Bluefin FEE claims are now valued CLAIM-DATE
  // historical-ONLY (stable → $1; SUI → CG-historical → DeFiLlama; other
  // non-stable → DeFiLlama; else pending). The current-spot fallbackA/fallbackB
  // last resort was REMOVED for fee claims (Rule 1a). v3 entries carry
  // spot-contaminated cold-cache fee values; bump flushes them.
  // v4 → v5 (Sprint 2.2c): fee-claim SUI side now reads getHistoricalOnlySuiPrice
  // (pure historical) instead of getCachedSuiPriceForTimestamp, which could return
  // the FIX-C cg-spot fallback on a CoinGecko-historical miss (Rule 1a leak). Flush
  // so any spot-contaminated cached fee value re-resolves via DeFiLlama / pending.
  return `bluefin-activity-v5-${positionId}`;
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
  tickLower?: number | null,
  tickUpper?: number | null,
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
    if (tickLower != null) params.set('tickLower', String(tickLower));
    if (tickUpper != null) params.set('tickUpper', String(tickUpper));

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
  }, [positionId, decimalsA, decimalsB, coinTypeA, coinTypeB, priceA, priceB, account, tickLower, tickUpper]);

  return { data, isLoading, error };
}
