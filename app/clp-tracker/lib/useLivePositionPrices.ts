"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Position } from "./types";
import { getPositionPrices } from "./storage";

// Stablecoin quotes price the base directly. Same set the Positions page has
// always used for its Range Health ratio.
const STABLES = new Set(["USDC", "USDT", "DAI", "USD"]);

/**
 * Current pair price (quote per base) for every position, for the pages that
 * do NOT already fetch it themselves.
 *
 * This exists so Dashboard / Total P&L / Pool P&L / the Sidebar can show the
 * same live position value the Positions page shows (Invariant #6 — the same
 * metric may not read differently on two pages). The Positions page keeps its
 * OWN existing fetch and does not use this hook, so no page ends up issuing two
 * calls for the same data.
 *
 * Resolution order matches the Positions page exactly: a manual per-position
 * price override wins, otherwise usd(base)/usd(quote) from /api/prices, and
 * null when either leg is unresolved — which callers treat as "fall back to the
 * stored currentBalance" rather than guessing.
 */
export function useLivePositionPrices(positions: Position[]) {
  const [fetchedPrices, setFetchedPrices] = useState<Record<string, number>>({});
  const [manualPrices, setManualPrices] = useState<Record<string, number>>({});
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  // Only ACTIVE positions need a live price; closed ones keep their recorded
  // value-at-close. Keyed on the symbol set so the fetch re-runs when the set
  // changes, not on every render of the positions array.
  const symbolKey = useMemo(() => {
    const s = new Set<string>();
    for (const p of positions) {
      if (p.status !== "active") continue;
      const b = p.token1Symbol.trim().toUpperCase();
      const q = p.token2Symbol.trim().toUpperCase();
      if (b) s.add(b);
      if (q && !STABLES.has(q)) s.add(q);
    }
    return [...s].sort().join(",");
  }, [positions]);

  const refresh = useCallback(async (key: string) => {
    if (!key) return;
    try {
      const res = await fetch(
        `/clp-tracker/api/prices?symbols=${encodeURIComponent(key)}`,
        { cache: "no-store" },
      );
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as {
        prices: Record<string, number>;
        updatedAt: string;
      };
      setFetchedPrices(data.prices ?? {});
      setUpdatedAt(data.updatedAt ?? new Date().toISOString());
    } catch {
      // Leave prices empty — every position falls back to its stored value.
    }
  }, []);

  useEffect(() => {
    setManualPrices(getPositionPrices());
    void refresh(symbolKey);
  }, [symbolKey, refresh]);

  const pairPriceById = useMemo(() => {
    const map = new Map<string, number | null>();
    for (const p of positions) {
      const manual = manualPrices[p.id];
      if (Number.isFinite(manual) && manual > 0) {
        map.set(p.id, manual);
        continue;
      }
      const base = p.token1Symbol.trim().toUpperCase();
      const quote = p.token2Symbol.trim().toUpperCase();
      const basePrice = fetchedPrices[base];
      const quotePrice = STABLES.has(quote) ? 1 : fetchedPrices[quote];
      map.set(
        p.id,
        Number.isFinite(basePrice) &&
          basePrice > 0 &&
          Number.isFinite(quotePrice) &&
          quotePrice > 0
          ? basePrice / quotePrice
          : null,
      );
    }
    return map;
  }, [positions, manualPrices, fetchedPrices]);

  return { pairPriceById, updatedAt };
}
