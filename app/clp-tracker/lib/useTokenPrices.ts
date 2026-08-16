"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getPriceCache, savePriceCache } from "./storage";
import { normalizeToken } from "./nameNormalization";
import type { FeeClaim } from "./types";

// Every reward-token symbol seen in claim records, normalized (WETH→ETH, etc.)
// and de-duped. Normalizing here means a WETH-only holding fetches the ETH
// (ethereum) price, so calcBusinessPnL's merged ETH bucket is always priced.
// Sorted so the derived cache key is stable across re-renders.
export function collectClaimSymbols(claims: FeeClaim[]): string[] {
  const symbols = new Set<string>();
  for (const c of claims) {
    const t1 = normalizeToken(c.token1Symbol);
    const t2 = normalizeToken(c.token2Symbol);
    if (t1) symbols.add(t1);
    if (t2) symbols.add(t2);
  }
  return [...symbols].sort();
}

// Manual overrides always win over auto-fetched prices (Sprint 8.5).
export function mergePrices(
  fetched: Record<string, number>,
  manual: Record<string, number>,
): Record<string, number> {
  const merged: Record<string, number> = { ...fetched };
  for (const [token, price] of Object.entries(manual)) {
    merged[token] = price;
  }
  return merged;
}

export interface TokenPricesState {
  fetchedPrices: Record<string, number>;
  updatedAt: string | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

// Current USD prices for the tokens appearing in `claims`, cached in
// localStorage so known values render instantly before the network round-trip.
//
// Single source for this behaviour: the Business P&L page and the Growth
// Target card both value the same fee tokens, and a second copy of the fetch
// and merge logic would let the two drift apart (Invariant #6).
export function useTokenPrices(claims: FeeClaim[]): TokenPricesState {
  const [fetchedPrices, setFetchedPrices] = useState<Record<string, number>>({});
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A string, not the array, so the fetch effect fires when the set of tokens
  // actually changes rather than on every re-render.
  const symbolKey = useMemo(
    () => collectClaimSymbols(claims).join(","),
    [claims],
  );

  const refresh = useCallback(async () => {
    if (symbolKey === "") return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/clp-tracker/api/prices?symbols=${encodeURIComponent(symbolKey)}`,
        { cache: "no-store" },
      );
      if (!res.ok) throw new Error(`Price service returned ${res.status}`);
      const data = (await res.json()) as {
        prices: Record<string, number>;
        updatedAt: string;
        error?: string;
      };
      const prices = data.prices ?? {};
      const stamp = data.updatedAt ?? new Date().toISOString();
      setFetchedPrices(prices);
      setUpdatedAt(stamp);
      savePriceCache({ prices, updatedAt: stamp });
      if (data.error) setError(data.error);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not reach price service.",
      );
    } finally {
      setLoading(false);
    }
  }, [symbolKey]);

  // Seed from the last successful fetch so the UI has numbers immediately.
  // Only fills gaps — a fresh fetch that already landed is never overwritten.
  useEffect(() => {
    const cache = getPriceCache();
    /* eslint-disable react-hooks/set-state-in-effect */
    setFetchedPrices((prev) =>
      Object.keys(prev).length > 0 ? prev : cache.prices,
    );
    setUpdatedAt((prev) => prev ?? cache.updatedAt);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  // Claims arrive after the parent hydrates from localStorage, so this keys on
  // the token set rather than running mount-only.
  useEffect(() => {
    // Fetching from an external service is exactly what effects are for; the
    // rule fires only because refresh() flips `loading` before awaiting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  return { fetchedPrices, updatedAt, loading, error, refresh };
}
