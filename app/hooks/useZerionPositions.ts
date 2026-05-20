"use client";

import { useEffect, useRef, useState } from "react";
import type { ZerionPosition } from "../api/zerion/positions/route";

// Hybrid-fallback hook. Calls our /api/zerion/positions route for a single
// EVM address and returns the resulting "basic data" position list. Skips
// Solana / Sui (they have deep integrations) and silently produces an empty
// list on any error path — Zerion is fallback-only, never load-bearing.

export interface UseZerionPositionsResult {
  positions: ZerionPosition[];
  isLoading: boolean;
  error:     string | null;
}

const EMPTY: UseZerionPositionsResult = {
  positions: [],
  isLoading: false,
  error:     null,
};

export function useZerionPositions(activeAddress: string | null): UseZerionPositionsResult {
  const [state, setState] = useState<UseZerionPositionsResult>(EMPTY);
  const fetchedForRef = useRef<string | null>(null);

  // Normalise the trigger. EVM addresses only — any non-0x value short-
  // circuits to the empty state.
  const evmAddress =
    activeAddress && /^0x[a-fA-F0-9]{40}$/.test(activeAddress)
      ? activeAddress.toLowerCase()
      : null;

  useEffect(() => {
    // No EVM address → reset to empty and bail. We DO clear here so a
    // wallet disconnect / switch from EVM to Solana wipes stale rows.
    if (!evmAddress) {
      fetchedForRef.current = null;
      setState(EMPTY);
      return;
    }

    // Deduplicate: same address as the last completed fetch → don't refire.
    if (fetchedForRef.current === evmAddress) return;
    fetchedForRef.current = evmAddress;

    let cancelled = false;
    setState((prev) => ({ ...prev, isLoading: true, error: null }));

    (async () => {
      try {
        const res = await fetch(`/api/zerion/positions?account=${evmAddress}`);
        if (cancelled) return;

        if (!res.ok) {
          // The route always returns 200 on graceful failure; a non-200
          // here means something is actively wrong with our own route.
          console.warn(`[useZerionPositions] /api/zerion/positions HTTP ${res.status}`);
          setState({ positions: [], isLoading: false, error: `HTTP ${res.status}` });
          return;
        }

        const data = (await res.json()) as { positions?: ZerionPosition[] };
        if (cancelled) return;

        setState({
          positions: data.positions ?? [],
          isLoading: false,
          error:     null,
        });
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[useZerionPositions] fetch failed: ${msg}`);
        // Fail silently — empty list, no error surfaced to UI.
        setState({ positions: [], isLoading: false, error: null });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [evmAddress]);

  return state;
}
