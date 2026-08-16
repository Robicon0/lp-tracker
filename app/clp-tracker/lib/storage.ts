import type {
  AppSettings,
  FeeClaim,
  LPRange,
  OutlierDismissal,
  StalePositionDismissal,
  PoolPnLEntry,
  Position,
  Transfer,
  Withdrawal,
} from "./types";

const KEYS = {
  positions: "clp_positions",
  claims: "clp_claims",
  transfers: "clp_transfers",
  settings: "clp_settings",
  ranges: "clp_ranges",
  poolPnl: "clp_pool_pnl",
  businessPnl: "clp_business_pnl",
  priceCache: "clp_price_cache",
  withdrawals: "clp_withdrawals",
  positionPrices: "clp_position_prices",
  outlierDismissals: "clp_outlier_dismissals",
  stalePositionDismissals: "clp_stale_position_dismissals",
  mixedStableNotice: "clp_mixed_stable_notice",
} as const;

// Single source of truth for settings defaults. The Settings page imports
// this rather than keeping its own copy — a duplicate previously drifted when
// initialCapital was added and only one copy was updated.
export const DEFAULT_SETTINGS: AppSettings = {
  transfersEnabled: true,
  currency: "USD",
  initialCapital: 0,
  targetMonthlyPercent: 0,
};

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function readArray<T>(key: string): T[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function writeValue<T>(key: string, value: T): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota exceeded or storage disabled — fail silently.
  }
}

export function getPositions(): Position[] {
  return readArray<Position>(KEYS.positions);
}

export function savePositions(positions: Position[]): void {
  writeValue(KEYS.positions, positions);
}

export function getClaims(): FeeClaim[] {
  return readArray<FeeClaim>(KEYS.claims);
}

export function saveClaims(claims: FeeClaim[]): void {
  writeValue(KEYS.claims, claims);
}

// Every stored transfer, soft-deleted ones included. Only the Recently Deleted
// UI and the save/restore/purge plumbing should read this — everything that
// shows or counts money must use getTransfers() so deleted rows stay invisible.
export function getAllTransfers(): Transfer[] {
  // Backfill legacy records: destination (Sprint 9) and moneyStatus. The
  // "Needs Review" (unset) state was retired; unset always behaved as
  // "redeployed" in every calculation, so defaulting it here changes no total.
  return readArray<Transfer>(KEYS.transfers).map((t) => ({
    ...t,
    destination: typeof t.destination === "string" ? t.destination : "",
    // Undeployed Tokens stay "idle" (unset) on purpose; everything else that
    // was unset defaults to redeployed (the retired "Needs Review" state).
    moneyStatus:
      t.moneyStatus ?? (t.transferType === "undeployed" ? undefined : "redeployed"),
  }));
}

// The live list: what every page, total and balance sees. Filtering here rather
// than at each call site is what makes a soft-deleted transfer behave exactly
// like a fully deleted one everywhere (Available Balance, Lifetime Earned,
// Deployed, Transferred, Expenses, Data Health, CSV export, the Sidebar …)
// without touching any of those readers.
export function getTransfers(): Transfer[] {
  return getAllTransfers().filter((t) => t.deletedAt === undefined);
}

export function getDeletedTransfers(): Transfer[] {
  return getAllTransfers()
    .filter((t) => t.deletedAt !== undefined)
    .sort((a, b) => (b.deletedAt ?? "").localeCompare(a.deletedAt ?? ""));
}

// Writes the live set while PRESERVING soft-deleted records the caller never
// saw. This matters because almost every mutation in the app is shaped
// saveTransfers(getTransfers().map(...)) — and getTransfers() hides deleted
// rows, so a plain overwrite would silently empty the Recently Deleted bin on
// the next edit anywhere in the app. Callers that legitimately need to remove a
// deleted record go through purgeTransfer instead.
export function saveTransfers(transfers: Transfer[]): void {
  const kept = new Set(transfers.map((t) => t.id));
  const orphanedDeleted = getAllTransfers().filter(
    (t) => t.deletedAt !== undefined && !kept.has(t.id),
  );
  writeValue(KEYS.transfers, [...transfers, ...orphanedDeleted]);
}

// Soft delete: keep the record, hide it everywhere. Reversible via restore.
export function softDeleteTransfer(id: string): void {
  writeValue(
    KEYS.transfers,
    getAllTransfers().map((t) =>
      t.id === id ? { ...t, deletedAt: new Date().toISOString() } : t,
    ),
  );
}

// Restore: drop deletedAt and nothing else, so the row comes back with its
// platform, deploy-link, sourceClaimId and notes exactly as they were.
export function restoreTransfer(id: string): void {
  writeValue(
    KEYS.transfers,
    getAllTransfers().map((t) => {
      if (t.id !== id) return t;
      const { deletedAt: _d, ...rest } = t;
      void _d;
      return rest;
    }),
  );
}

// The only path that actually erases a transfer. Deliberately a raw write:
// saveTransfers would re-attach the very record being purged.
export function purgeTransfer(id: string): void {
  writeValue(
    KEYS.transfers,
    getAllTransfers().filter((t) => t.id !== id),
  );
}

// One-time persisted backfill so every stored transfer has an explicit
// moneyStatus (retiring "Needs Review"). Idempotent, and a pure no-op for
// totals: unset was already treated as "redeployed" everywhere. Returns true
// if it rewrote anything.
export function migrateTransferMoneyStatus(): boolean {
  const raw = readArray<Transfer>(KEYS.transfers);
  let changed = false;
  const next = raw.map((t) => {
    // Leave Undeployed Tokens idle (unset); backfill only the others.
    if (t.moneyStatus === undefined && t.transferType !== "undeployed") {
      changed = true;
      return { ...t, moneyStatus: "redeployed" as const };
    }
    return t;
  });
  if (changed) writeValue(KEYS.transfers, next);
  return changed;
}

export function getOutlierDismissals(): OutlierDismissal[] {
  return readArray<OutlierDismissal>(KEYS.outlierDismissals);
}

export function saveOutlierDismissals(dismissals: OutlierDismissal[]): void {
  writeValue(KEYS.outlierDismissals, dismissals);
}

export function getStalePositionDismissals(): StalePositionDismissal[] {
  return readArray<StalePositionDismissal>(KEYS.stalePositionDismissals);
}

export function saveStalePositionDismissals(
  dismissals: StalePositionDismissal[],
): void {
  writeValue(KEYS.stalePositionDismissals, dismissals);
}

// One-time diagnostic notice: the mixed-claim (stable-leg) recovery report.
// Purely a "have you seen this" flag — it gates no calculation, so it is
// deliberately NOT part of the Settings backup (a restored backup showing the
// report again is harmless; hiding it on a fresh machine is not).
export function isMixedStableNoticeDismissed(): boolean {
  if (!isBrowser()) return false;
  try {
    return window.localStorage.getItem(KEYS.mixedStableNotice) === "true";
  } catch {
    return false;
  }
}

export function dismissMixedStableNotice(): void {
  writeValue(KEYS.mixedStableNotice, true);
}

export function getWithdrawals(): Withdrawal[] {
  return readArray<Withdrawal>(KEYS.withdrawals);
}

export function saveWithdrawals(withdrawals: Withdrawal[]): void {
  writeValue(KEYS.withdrawals, withdrawals);
}

export function getSettings(): AppSettings {
  if (!isBrowser()) return { ...DEFAULT_SETTINGS };
  try {
    const raw = window.localStorage.getItem(KEYS.settings);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AppSettings): void {
  writeValue(KEYS.settings, settings);
}

export function getRanges(): LPRange[] {
  return readArray<LPRange>(KEYS.ranges);
}

export function saveRanges(ranges: LPRange[]): void {
  writeValue(KEYS.ranges, ranges);
}

export function getPoolPnL(): PoolPnLEntry[] {
  return readArray<PoolPnLEntry>(KEYS.poolPnl);
}

export function savePoolPnL(entries: PoolPnLEntry[]): void {
  writeValue(KEYS.poolPnl, entries);
}

export interface BusinessPnLSettings {
  prices: Record<string, number>;
  checkpoints: string[];
}

export function getBusinessPnLSettings(): BusinessPnLSettings {
  if (!isBrowser()) return { prices: {}, checkpoints: [] };
  try {
    const raw = window.localStorage.getItem(KEYS.businessPnl);
    if (!raw) return { prices: {}, checkpoints: [] };
    const parsed = JSON.parse(raw) as Partial<BusinessPnLSettings>;
    return {
      prices:
        parsed.prices && typeof parsed.prices === "object"
          ? parsed.prices
          : {},
      checkpoints: Array.isArray(parsed.checkpoints) ? parsed.checkpoints : [],
    };
  } catch {
    return { prices: {}, checkpoints: [] };
  }
}

export function saveBusinessPnLSettings(settings: BusinessPnLSettings): void {
  writeValue(KEYS.businessPnl, settings);
}

// Last successfully fetched auto-prices, so the page can show known values
// instantly on load before the network round-trip completes.
export interface PriceCache {
  prices: Record<string, number>;
  updatedAt: string | null;
}

export function getPriceCache(): PriceCache {
  if (!isBrowser()) return { prices: {}, updatedAt: null };
  try {
    const raw = window.localStorage.getItem(KEYS.priceCache);
    if (!raw) return { prices: {}, updatedAt: null };
    const parsed = JSON.parse(raw) as Partial<PriceCache>;
    return {
      prices:
        parsed.prices && typeof parsed.prices === "object"
          ? parsed.prices
          : {},
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
    };
  } catch {
    return { prices: {}, updatedAt: null };
  }
}

export function savePriceCache(cache: PriceCache): void {
  writeValue(KEYS.priceCache, cache);
}

// Manual current-price overrides per position (Sprint 11), used when a
// pair's live price can't be auto-fetched. Keyed by position id.
export function getPositionPrices(): Record<string, number> {
  if (!isBrowser()) return {};
  try {
    const raw = window.localStorage.getItem(KEYS.positionPrices);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, number>)
      : {};
  } catch {
    return {};
  }
}

export function savePositionPrices(prices: Record<string, number>): void {
  writeValue(KEYS.positionPrices, prices);
}
