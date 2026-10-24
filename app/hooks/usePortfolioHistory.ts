"use client";

import { useState, useEffect } from "react";

export interface PortfolioSnapshot {
  timestamp: number;  // ms since epoch
  totalValue: number;
  positionCount: number;
  /**
   * Saved under the whole-total rule (2026-10-25 onward). Points without it were
   * saved before that rule and may hold a partial total; they stay stored and
   * charted, but no headline figure is computed from them.
   */
  trusted?: true;
  /** The wallet set the total belongs to (PositionsContext `walletKey`). */
  walletKey?: string;
}

const STORAGE_KEY = "lp-portfolio-history";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_POINTS = 1000;                        // cap total stored points

export function usePortfolioHistory(
  totalValue: number,
  positionCount: number,
  dataUpdatedAt: number,
  /**
   * The total is whole: every positions source answered and no scan was
   * truncated or failed (batch D 1c). A partial total is never saved — it was
   * what put the dips in the chart (points with 1-3 positions among 18-21).
   */
  complete = true,
  walletKey = "",
): PortfolioSnapshot[] {
  const [history, setHistory] = useState<PortfolioSnapshot[]>([]);

  // Load persisted history on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as PortfolioSnapshot[];
        const cutoff = Date.now() - MAX_AGE_MS;
        setHistory(parsed.filter((p) => p.timestamp >= cutoff));
      }
    } catch {
      // localStorage unavailable or corrupt — start fresh
    }
  }, []);

  // Save a snapshot whenever a new fetch completes (dataUpdatedAt changes)
  useEffect(() => {
    if (dataUpdatedAt === 0 || totalValue === 0 || !complete || !walletKey) return;

    setHistory((prev) => {
      const cutoff = Date.now() - MAX_AGE_MS;
      let recent = prev.filter((p) => p.timestamp >= cutoff);

      // Skip if this exact timestamp was already saved
      if (recent.length > 0 && recent[recent.length - 1].timestamp === dataUpdatedAt) return prev;

      recent = [...recent, { timestamp: dataUpdatedAt, totalValue, positionCount, trusted: true, ...(walletKey ? { walletKey } : {}) }];

      // Trim to MAX_POINTS, keeping newest
      if (recent.length > MAX_POINTS) recent = recent.slice(recent.length - MAX_POINTS);

      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(recent));
      } catch {
        // Quota exceeded or private browsing — ignore
      }

      return recent;
    });
  }, [dataUpdatedAt, totalValue, positionCount, complete, walletKey]);

  return history;
}
