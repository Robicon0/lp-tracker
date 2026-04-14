"use client";

import { useState, useEffect } from "react";
import type { ActivityEvent } from "../api/hyperswap/activity/route";

export type { ActivityEvent };

export interface HyperSwapActivityData {
  events: ActivityEvent[];
  netInvested0: number;
  netInvested1: number;
  totalFees0: number;
  totalFees1: number;
}

interface CacheEntry {
  data: HyperSwapActivityData;
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

// Derive NFT manager address from protocol name
const PROTOCOL_NFT_MANAGERS: Record<string, string> = {
  'HyperSwap': '0x6eda206207c09e5428f281761ddc0d300851fbc8',
  'KittenSwap': '0xb9201e89f94a01ff13ad4caecf43a2e232513754',
  'ProjectX': '0xead19ae861c29bbb2101e834922b2feee69b9091',
};

// v2 key: invalidates entries cached before tickLower/tickUpper were passed
// through for V3 price derivation.
function cacheKey(positionId: string) {
  return `hyperswap-activity-v2-${positionId}`;
}

function readCache(positionId: string): HyperSwapActivityData | null {
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

function writeCache(positionId: string, data: HyperSwapActivityData) {
  try {
    const entry: CacheEntry = { data, fetchedAt: Date.now() };
    localStorage.setItem(cacheKey(positionId), JSON.stringify(entry));
  } catch {
    // Quota exceeded — ignore
  }
}

export function useHyperSwapActivity(
  positionId: string | null,   // numeric tokenId string; null = skip
  protocol: string | null,     // 'HyperSwap' | 'KittenSwap' | 'ProjectX'
  token0Decimals: number,
  token1Decimals: number,
  token0Address?: string,
  token1Address?: string,
  price0?: number,
  price1?: number,
  tickLower?: number | null,
  tickUpper?: number | null,
) {
  const [data, setData] = useState<HyperSwapActivityData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!positionId || !protocol) return;
    const nftManager = PROTOCOL_NFT_MANAGERS[protocol];
    if (!nftManager) return;

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
      nftManager,
      t0d: String(token0Decimals),
      t1d: String(token1Decimals),
    });
    if (token0Address) params.set('token0', token0Address);
    if (token1Address) params.set('token1', token1Address);
    if (price0 != null) params.set('p0', String(price0));
    if (price1 != null) params.set('p1', String(price1));
    if (tickLower != null) params.set('tickLower', String(tickLower));
    if (tickUpper != null) params.set('tickUpper', String(tickUpper));

    fetch(`/api/hyperswap/activity?${params.toString()}`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (json.error) {
          setError(json.error);
          return;
        }
        const result = json as HyperSwapActivityData;
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
  }, [positionId, protocol, token0Decimals, token1Decimals, token0Address, token1Address, price0, price1, tickLower, tickUpper]);

  return { data, isLoading, error };
}
