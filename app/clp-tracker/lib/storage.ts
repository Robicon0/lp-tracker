import type {
  AppSettings,
  CapitalContribution,
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
  capitalContributions: "clp_capital_contributions",
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
  initialCapital: 0, // superseded by capitalContributions; kept so old blobs parse
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

// A write that could not be made must never look like one that was. This used
// to swallow every failure, so a full quota, a disabled store, or a private
// window turned "your edit is saved" into a no-op with nothing on screen —
// the silent-failure class architecture Rule 11 exists to end. It now THROWS,
// and the callers on the Transfers page turn that into an on-screen message.
export class StorageWriteError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "StorageWriteError";
  }
}

function writeValue<T>(key: string, value: T): void {
  if (!isBrowser()) return;
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (err) {
    throw new StorageWriteError(
      "the record could not be encoded for storage",
      err,
    );
  }
  try {
    window.localStorage.setItem(key, serialized);
  } catch (err) {
    const quota =
      err instanceof DOMException &&
      (err.name === "QuotaExceededError" ||
        err.name === "NS_ERROR_DOM_QUOTA_REACHED");
    throw new StorageWriteError(
      quota
        ? "this browser's storage for the site is full, so nothing was written"
        : "this browser refused to write to storage (private window, or site data blocked)",
      err,
    );
  }
  // Read it straight back. setItem can resolve without the value landing (an
  // evicted or racing store), and a write that did not land must be reported,
  // never assumed.
  if (window.localStorage.getItem(key) !== serialized) {
    throw new StorageWriteError(
      "the write did not land — storage read back a different value",
    );
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

// Every stored capital entry, soft-deleted ones included. Only the history
// modal's delete plumbing should read this; totals use getCapitalContributions.
export function getAllCapitalContributions(): CapitalContribution[] {
  return readArray<CapitalContribution>(KEYS.capitalContributions);
}

// The live ledger: what Initial Capital is summed from (calcInitialCapital).
export function getCapitalContributions(): CapitalContribution[] {
  return getAllCapitalContributions().filter((c) => c.deletedAt === undefined);
}

// Writes the live set while keeping soft-deleted entries the caller never saw
// (getCapitalContributions hides them), same reasoning as saveTransfers.
export function saveCapitalContributions(
  contributions: CapitalContribution[],
): void {
  const kept = new Set(contributions.map((c) => c.id));
  const orphanedDeleted = getAllCapitalContributions().filter(
    (c) => c.deletedAt !== undefined && !kept.has(c.id),
  );
  writeValue(KEYS.capitalContributions, [...contributions, ...orphanedDeleted]);
}

export function softDeleteCapitalContribution(id: string): void {
  writeValue(
    KEYS.capitalContributions,
    getAllCapitalContributions().map((c) =>
      c.id === id ? { ...c, deletedAt: new Date().toISOString() } : c,
    ),
  );
}

export const CAPITAL_HISTORY_BACKUP_KEY = "clp_settings_backup_pre_capital_history";

// One-time move of the old single Initial Capital number into the ledger.
// Runs only while NO entry has ever been stored (soft-deleted ones count, so
// deleting the migrated entry can't bring it back) and the backup key it writes
// is absent (so clearing the ledger can't either), and only for a non-zero
// value. The stored settings are copied to the backup key BEFORE the entry is
// written; a failed write throws, and nothing after it runs. Returns true when
// it migrated.
export function migrateCapitalHistory(): boolean {
  if (!isBrowser()) return false;
  if (getAllCapitalContributions().length > 0) return false;
  if (window.localStorage.getItem(CAPITAL_HISTORY_BACKUP_KEY) !== null) return false;
  const rawSettings = window.localStorage.getItem(KEYS.settings);
  const capital = Number(getSettings().initialCapital) || 0;
  if (rawSettings === null || capital === 0) return false;
  writeValue(CAPITAL_HISTORY_BACKUP_KEY, JSON.parse(rawSettings) as unknown);
  writeValue<CapitalContribution[]>(KEYS.capitalContributions, [
    {
      id: newRecordId(),
      date: "2025-11-25T00:00:00.000Z",
      amount: capital,
      notes: "Starting capital (migrated from the old single Initial Capital field)",
    },
  ]);
  return true;
}

// What every page that shows Initial Capital loads on hydrate: the migration
// (a no-op after its one run) then the live ledger. A failed migration write
// is returned as an error so the card can say so instead of showing $0.
export function loadCapitalContributions(): {
  contributions: CapitalContribution[];
  error: string | null;
} {
  try {
    migrateCapitalHistory();
    return { contributions: getCapitalContributions(), error: null };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      contributions: getCapitalContributions(),
      error: `Couldn’t move the old Initial Capital into the history — ${detail}. Nothing was changed.`,
    };
  }
}

export function newRecordId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
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
