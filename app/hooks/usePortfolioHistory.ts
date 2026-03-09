"use client";

import { useState, useEffect } from "react";

export interface PortfolioSnapshot {
  timestamp: number;  // ms since epoch
  totalValue: number;
  positionCount: number;
}

const STORAGE_KEY = "lp-portfolio-history";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MIN_INTERVAL_MS = 60 * 60 * 1000;        // 1 hour between snapshots

export function usePortfolioHistory(
  totalValue: number,
  positionCount: number,
  dataUpdatedAt: number,
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
    if (dataUpdatedAt === 0 || totalValue === 0) return;

    setHistory((prev) => {
      const cutoff = Date.now() - MAX_AGE_MS;
      const recent = prev.filter((p) => p.timestamp >= cutoff);

      // Throttle: skip if last snapshot is too recent
      const last = recent[recent.length - 1];
      if (last && dataUpdatedAt - last.timestamp < MIN_INTERVAL_MS) return prev;

      const next = [
        ...recent,
        { timestamp: dataUpdatedAt, totalValue, positionCount },
      ];

      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Quota exceeded or private browsing — ignore
      }

      return next;
    });
  }, [dataUpdatedAt, totalValue, positionCount]);

  return history;
}
