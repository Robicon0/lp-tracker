"use client";

import { useState, useEffect } from "react";

export interface PortfolioSnapshot {
  timestamp: number;  // ms since epoch
  totalValue: number;
  positionCount: number;
}

const STORAGE_KEY = "lp-portfolio-history";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_POINTS = 1000;                        // cap total stored points

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
      let recent = prev.filter((p) => p.timestamp >= cutoff);

      // Skip if this exact timestamp was already saved
      if (recent.length > 0 && recent[recent.length - 1].timestamp === dataUpdatedAt) return prev;

      recent = [...recent, { timestamp: dataUpdatedAt, totalValue, positionCount }];

      // Trim to MAX_POINTS, keeping newest
      if (recent.length > MAX_POINTS) recent = recent.slice(recent.length - MAX_POINTS);

      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(recent));
      } catch {
        // Quota exceeded or private browsing — ignore
      }

      return recent;
    });
  }, [dataUpdatedAt, totalValue, positionCount]);

  return history;
}
