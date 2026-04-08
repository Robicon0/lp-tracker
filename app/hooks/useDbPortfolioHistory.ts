"use client";

import { useEffect, useState, useCallback } from "react";

export interface DbPortfolioSnapshot {
  timestamp: number;
  totalValue: number;
  lpValue: number;
  lendingValue: number;
  tokenValue: number;
  fees: number;
  positionCount: number;
}

export type HistoryRange = "7d" | "30d" | "90d" | "all";

export function useDbPortfolioHistory(
  wallet: string | undefined | Array<string | undefined | null>,
  range: HistoryRange,
) {
  const [snapshots, setSnapshots] = useState<DbPortfolioSnapshot[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [configured, setConfigured] = useState<boolean>(true);

  // Normalize to a sorted, deduped, comma-joined key so the useCallback
  // dep below stays stable across renders even when an array is passed.
  const walletsKey = (Array.isArray(wallet) ? wallet : [wallet])
    .filter((w): w is string => typeof w === "string" && w.length > 0)
    .slice()
    .sort()
    .join(",");

  const refetch = useCallback(async () => {
    if (!walletsKey) {
      setSnapshots([]);
      return;
    }
    setIsLoading(true);
    try {
      // No wallet filter — the API sums every snapshot row in DB per 5s
      // batch window so the chart shows the user's true cross-wallet
      // portfolio total even when wagmi is currently connected to a
      // different EVM account than the one snapshotted previously.
      const r = await fetch(`/api/history/portfolio?range=${range}`);
      const data = await r.json();
      if (data.error === "DB not configured") setConfigured(false);
      else setConfigured(true);
      setSnapshots(data.snapshots || []);
    } catch {
      setSnapshots([]);
    } finally {
      setIsLoading(false);
    }
  }, [walletsKey, range]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { snapshots, isLoading, configured, refetch };
}

export function useDbPositionHistory(positionId: string | undefined, range: HistoryRange) {
  const [snapshots, setSnapshots] = useState<
    { timestamp: number; value: number; fees: number; claimedFees: number; status: string }[]
  >([]);
  const [isLoading, setIsLoading] = useState(false);
  const [configured, setConfigured] = useState(true);

  useEffect(() => {
    if (!positionId) {
      setSnapshots([]);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    fetch(`/api/history/position?id=${encodeURIComponent(positionId)}&range=${range}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.error === "DB not configured") setConfigured(false);
        else setConfigured(true);
        setSnapshots(data.snapshots || []);
      })
      .catch(() => {
        if (!cancelled) setSnapshots([]);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [positionId, range]);

  return { snapshots, isLoading, configured };
}
