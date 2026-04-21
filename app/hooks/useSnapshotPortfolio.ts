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
// a P&L (oldest snapshot → current live value). Strict gating — a range
// is marked `available: true` ONLY when there are ≥2 snapshots in the
// window AND the oldest / newest snapshots are far enough apart to be a
// meaningful comparison (configured per range). Otherwise `available`
// is false and the UI shows "Not enough data yet" or
// "Tracking started … check back in N days".

export type SnapshotRangeKey = "1D" | "7D" | "30D" | "1Y";

const RANGE_DAYS: Record<SnapshotRangeKey, number> = {
  "1D": 1,
  "7D": 7,
  "30D": 30,
  "1Y": 365,
};

// Minimum hours between the oldest and newest in-range snapshots for a
// range to be considered "enough data". Prevents the toggle from showing
// a bogus P&L computed from two snapshots taken minutes apart.
const MIN_HOURS_APART: Record<SnapshotRangeKey, number> = {
  "1D":  20,          // 20 hours
  "7D":  6 * 24,      // 6 days
  "30D": 25 * 24,     // 25 days
  "1Y":  300 * 24,    // 300 days
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
  // When `available` is false, `checkBackInDays` tells the UI how long
  // until the user is expected to have a valid comparison. 0 means
  // "less than a day"; use the "Not enough data yet — check back tomorrow"
  // copy for 1D specifically.
  checkBackInDays: number;
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
  checkBackInDays: 0,
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
            totalLpValue:  addr === addrList[0] ? currentLpValue     : 0,
            lendingValue:  addr === addrList[0] ? currentLendingValue : 0,
            tokenValue:    addr === addrList[0] ? currentTokenValue  : 0,
            positionCount: addr === addrList[0] ? positionCount      : 0,
          }),
        }).catch((err) => console.error("[useSnapshotPortfolio] save failed:", err))
      ),
    ).catch(() => { /* already logged */ });
  }, [addrKey, currentTotalValue, currentLpValue, currentLendingValue, currentTokenValue, positionCount]);

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
        const trackingStartMs = trackingSince ? new Date(trackingSince).getTime() : now;
        const daysSinceStart = Math.max(0, (now - trackingStartMs) / 86_400_000);

        const byRange = {} as Record<SnapshotRangeKey, SnapshotRangeResult>;
        for (const key of Object.keys(RANGE_DAYS) as SnapshotRangeKey[]) {
          const cutoff = now - RANGE_DAYS[key] * 86_400_000;
          const inRange = snapshots.filter((s) => new Date(s.timestamp).getTime() >= cutoff);
          const minHours = MIN_HOURS_APART[key];
          const minDaysNeeded = minHours / 24;

          // Gate 1: need ≥2 snapshots in the range.
          // Gate 2: oldest and newest must be ≥ minHoursApart apart.
          const hasTwo = inRange.length >= 2;
          const spanHours = hasTwo
            ? (new Date(inRange[inRange.length - 1].timestamp).getTime()
               - new Date(inRange[0].timestamp).getTime()) / 3_600_000
            : 0;
          const enoughSpan = spanHours >= minHours;

          if (!hasTwo || !enoughSpan) {
            const daysToGo = Math.max(0, Math.ceil(minDaysNeeded - daysSinceStart));
            byRange[key] = {
              value: currentTotalValue,
              oldestValue: null,
              oldestTimestamp: null,
              pnlDollar: null,
              pnlPct: null,
              available: false,
              checkBackInDays: daysToGo,
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
            checkBackInDays: 0,
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
