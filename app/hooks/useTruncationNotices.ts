"use client";

import { useSyncExternalStore } from "react";
import {
  getTruncationSnapshot,
  getTruncationServerSnapshot,
  subscribeTruncation,
  type TruncationNotice,
} from "../lib/enumerationTruncation";

/**
 * Subscribe to the enumeration-truncation registry (queue item C, Phase 1).
 *
 * Returns [] when every scan this session was complete, so a caller can render
 * `notices.length > 0 && <banner/>` with no other gating. The registry lives
 * outside React because the position fetchers are plain functions called from
 * React Query's queryFn — changing all ten fetcher signatures to thread a
 * second return value through PositionsContext would be a far wider change than
 * this disclosure warrants.
 */
export function useTruncationNotices(): TruncationNotice[] {
  return useSyncExternalStore(
    subscribeTruncation,
    getTruncationSnapshot,
    getTruncationServerSnapshot,
  );
}
