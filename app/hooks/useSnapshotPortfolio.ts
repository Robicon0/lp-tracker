"use client";

import { useEffect, useRef, useState } from "react";

// Daily portfolio snapshots, stored server-side in Postgres/Neon.
//
// On mount / whenever the current LP value changes, this hook POSTs the
// latest value to /api/snapshots/save. The server owns "one snapshot per
// UTC day" semantics, so we can fire this on every positions refresh
// without worrying about row inflation.
//
// It also fetches the snapshot series for the given range and computes
// a P&L (oldest snapshot → current live value). If the range covers a
// period the user wasn't tracking yet, `available` is false and the UI
// should fall back to "Tracking started — N days of data collected".

export type SnapshotRangeKey = "1D" | "7D" | "30D" | "1Y";

const RANGE_DAYS: Record<SnapshotRangeKey, number> = {
  "1D": 1,
  "7D": 7,
  "30D": 30,
  "1Y": 365,
};

export interface SnapshotPoint {
  timestamp: string;
  totalValue: number;
  lpValue: number;
  lendingValue: number;
  tokenValue: number;
  positionCount: number;
}

export interface SnapshotRangeResult {
  value: number;
  oldestValue: number | null;
  oldestTimestamp: string | null;
  pnlDollar: number | null;
  pnlPct: number | null;
  available: boolean;
}

export interface UseSnapshotPortfolioData {
  byRange: Record<SnapshotRangeKey, SnapshotRangeResult>;
  snapshots: SnapshotPoint[];
  trackingSince: string | null;
  daysTracked: number;
  isLoading: boolean;
}

const EMPTY_RANGE: SnapshotRangeResult = {
  value: 0,
  oldestValue: null,
  oldestTimestamp: null,
  pnlDollar: null,
  pnlPct: null,
  available: false,
};

export function useSnapshotPortfolio(
  addresses: string[],
  currentTotalValue: number,
  currentLpValue: number,
  currentLendingValue: number,
  currentTokenValue: number,
  positionCount: number,
): UseSnapshotPortfolioData {
  const addrKey = addresses
    .map((a) => a.toLowerCase())
    .filter(Boolean)
    .sort()
    .join(",");

  const [data, setData] = useState<UseSnapshotPortfolioData>({
    byRange: { "1D": EMPTY_RANGE, "7D": EMPTY_RANGE, "30D": EMPTY_RANGE, "1Y": EMPTY_RANGE },
    snapshots: [],
    trackingSince: null,
    daysTracked: 0,
    isLoading: false,
  });

  // Track what we last saved so we don't spam the save endpoint with
  // identical values.
  const lastSavedRef = useRef<{ key: string; value: number }>({ key: "", value: 0 });

  // Save current value (server dedupes per UTC day)
  useEffect(() => {
    if (!addrKey) return;
    if (!Number.isFinite(currentTotalValue) || currentTotalValue <= 0) return;

    // Fire one save per (address-set, value) change
    const sig = `${addrKey}|${Math.round(currentTotalValue * 100)}`;
    if (lastSavedRef.current.key === sig) return;
    lastSavedRef.current = { key: sig, value: currentTotalValue };

    const addrList = addrKey.split(",");
    Promise.all(
      addrList.map((addr) =>
        fetch("/api/snapshots/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            walletAddress: addr,
            // Split current totals across wallets proportionally — we don't
            // know per-wallet totals at this layer, so put the full total
            // on the first address and zeros elsewhere. This keeps the
            // aggregated sum correct when reading back via the range API.
            totalLpValue:  addr === addrList[0] ? currentLpValue     : 0,
            lendingValue:  addr === addrList[0] ? currentLendingValue : 0,
            tokenValue:    addr === addrList[0] ? currentTokenValue  : 0,
            positionCount: addr === addrList[0] ? positionCount      : 0,
          }),
        }).catch((err) => console.error("[useSnapshotPortfolio] save failed:", err))
      ),
    ).catch(() => { /* already logged */ });
  }, [addrKey, currentTotalValue, currentLpValue, currentLendingValue, currentTokenValue, positionCount]);

  // Fetch snapshot series for the longest range (1Y) and derive every
  // subrange from it in memory.
  useEffect(() => {
    if (!addrKey) {
      setData({
        byRange: { "1D": EMPTY_RANGE, "7D": EMPTY_RANGE, "30D": EMPTY_RANGE, "1Y": EMPTY_RANGE },
        snapshots: [],
        trackingSince: null,
        daysTracked: 0,
        isLoading: false,
      });
      return;
    }

    let cancelled = false;
    setData((prev) => ({ ...prev, isLoading: true }));

    (async () => {
      try {
        const res = await fetch(
          `/api/snapshots/range?address=${encodeURIComponent(addrKey)}&days=${RANGE_DAYS["1Y"]}`,
        ).then((r) => r.json() as Promise<{
          ok: boolean;
          snapshots?: SnapshotPoint[];
          trackingSince?: string | null;
          daysTracked?: number;
        }>);
        if (cancelled) return;

        const snapshots = res.snapshots ?? [];
        const trackingSince = res.trackingSince ?? null;
        const daysTracked = res.daysTracked ?? 0;

        const now = Date.now();
        const byRange = {} as Record<SnapshotRangeKey, SnapshotRangeResult>;
        for (const key of Object.keys(RANGE_DAYS) as SnapshotRangeKey[]) {
          const cutoff = now - RANGE_DAYS[key] * 86_400_000;
          const inRange = snapshots.filter((s) => new Date(s.timestamp).getTime() >= cutoff);
          if (inRange.length === 0) {
            byRange[key] = {
              value: currentTotalValue,
              oldestValue: null,
              oldestTimestamp: null,
              pnlDollar: null,
              pnlPct: null,
              available: false,
            };
            continue;
          }
          const oldest = inRange[0];
          const pnlDollar = currentTotalValue - oldest.totalValue;
          const pnlPct = oldest.totalValue > 0 ? (pnlDollar / oldest.totalValue) * 100 : null;
          byRange[key] = {
            value: currentTotalValue,
            oldestValue: oldest.totalValue,
            oldestTimestamp: oldest.timestamp,
            pnlDollar,
            pnlPct,
            available: true,
          };
        }

        setData({ byRange, snapshots, trackingSince, daysTracked, isLoading: false });
      } catch (err) {
        console.error("[useSnapshotPortfolio] range fetch failed:", err);
        if (!cancelled) setData((prev) => ({ ...prev, isLoading: false }));
      }
    })();

    return () => { cancelled = true; };
  }, [addrKey, currentTotalValue]);

  return data;
}
