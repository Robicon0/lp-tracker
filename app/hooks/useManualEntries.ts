"use client";

import { useCallback, useEffect, useState } from "react";

// Client wrapper around /api/position-entries. Owns the in-memory map of
// saved entries plus a save() method that POSTs and merges the response.
//
// Keyed by position_id (string). Only the active EVM wallet's entries are
// loaded — the API normalises wallet addresses to lowercase server-side, but
// we lowercase here too so the lookup map key is stable across re-renders.

export interface ManualEntry {
  positionId: string;
  depositUsd: number;
  withdrawalUsd: number;
  createdAt: string;
  updatedAt: string;
}

export interface UseManualEntriesResult {
  entriesByPositionId: Record<string, ManualEntry>;
  isLoading: boolean;
  error: string | null;
  /** Returns `{ ok: true }` on success or `{ ok: false, reason }` on failure. */
  save: (positionId: string, depositUsd: number, withdrawalUsd: number) =>
    Promise<{ ok: true } | { ok: false; reason: string }>;
}

export function useManualEntries(walletAddress: string | null | undefined): UseManualEntriesResult {
  const wallet = walletAddress ? walletAddress.toLowerCase() : null;
  const [entriesByPositionId, setEntries] = useState<Record<string, ManualEntry>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!wallet) {
      setEntries({});
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    fetch(`/api/position-entries?wallet=${encodeURIComponent(wallet)}`)
      .then((r) => r.json())
      .then((json: { ok?: boolean; entries?: ManualEntry[]; reason?: string }) => {
        if (cancelled) return;
        if (!json.ok) {
          setError(json.reason ?? "fetch_failed");
          setEntries({});
          return;
        }
        const map: Record<string, ManualEntry> = {};
        for (const e of json.entries ?? []) map[e.positionId] = e;
        setEntries(map);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err));
        setEntries({});
      })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [wallet]);

  const save = useCallback(
    async (positionId: string, depositUsd: number, withdrawalUsd: number) => {
      if (!wallet) return { ok: false, reason: "no_wallet" as const };
      try {
        const res = await fetch("/api/position-entries", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wallet, positionId, depositUsd, withdrawalUsd }),
        });
        const json: { ok?: boolean; entry?: ManualEntry; reason?: string } = await res.json();
        if (!json.ok || !json.entry) {
          return { ok: false as const, reason: json.reason ?? `http_${res.status}` };
        }
        setEntries((prev) => ({ ...prev, [json.entry!.positionId]: json.entry! }));
        return { ok: true as const };
      } catch (err) {
        return { ok: false as const, reason: String(err) };
      }
    },
    [wallet],
  );

  return { entriesByPositionId, isLoading, error, save };
}
