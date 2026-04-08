"use client";

// Stubbed after the DB-backed snapshot system was removed. The analytics page
// no longer renders a historical P&L chart, but the orphaned legacy position
// detail route at app/dashboard/[id]/page.tsx still imports useDbPositionHistory.
// Keeping these as no-op hooks lets that route compile without touching it.

export type HistoryRange = "7d" | "30d" | "90d" | "all";

export interface DbPortfolioSnapshot {
  timestamp: number;
  totalValue: number;
  lpValue: number;
  lendingValue: number;
  tokenValue: number;
  fees: number;
  positionCount: number;
}

export function useDbPortfolioHistory(
  _wallet: string | undefined | Array<string | undefined | null>,
  _range: HistoryRange,
) {
  return {
    snapshots: [] as DbPortfolioSnapshot[],
    isLoading: false,
    configured: false,
    refetch: async () => {},
  };
}

export function useDbPositionHistory(_positionId: string | undefined, _range: HistoryRange) {
  return {
    snapshots: [] as { timestamp: number; value: number; fees: number; claimedFees: number; status: string }[],
    isLoading: false,
    configured: false,
  };
}
