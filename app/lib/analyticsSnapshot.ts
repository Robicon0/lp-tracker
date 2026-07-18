// Sprint INSTANT-LOAD — per-wallet-set snapshot of the analytics page's COMPUTED
// aggregates (stale-while-revalidate).
//
// WHY THIS EXISTS
// Every cache layer before this one held RAW PIECES (historical prices, pool
// metadata, closed-position scans, 5-min route results) — nothing cached the
// COMPUTED OUTPUT. So any visit >5 min after the last one re-ran the entire
// pipeline (every position route, every activity route, every wallet-scope scan)
// before the user saw a single aggregate: measured 77–88 s time-to-all-numbers
// for a fully raw-warm returning wallet (aerodrome ever-owned scan 77 s, 3× Sui
// tx-history scans ~21–26 s, an expired-empty solana-closed rescan 88 s).
//
// THE FIX
// After the analytics pipeline settles CLEANLY, the client posts the aggregates
// it just rendered (header cards + Fee Income + LP P&L) here; the next visit
// reads them FIRST and renders every number instantly (<2 s), then the normal
// live pipeline refreshes them in the background ("updated N min ago" → "just
// now"). This is a CACHE OF COMPUTED OUTPUT — zero new calculation paths; the
// values stored are exactly what the last full compute displayed, so
// byte-identity with a fresh compute holds by construction (B7-C verified).
//
// STALENESS POLICY (Phase A §4, user-approved)
// - Redis TTL 24 h: a snapshot older than a day is never served (day-old spot
//   prices mislead); the wallet falls back to the first-visit streaming path.
// - Within 24 h: served instantly regardless of age; the background refresh
//   ALWAYS runs and rewrites the snapshot when it settles.
// - NEVER written from an incomplete/failed compute (same discipline as the
//   closed-position empty-never-cached rule) — the write path requires the
//   pipeline settled with zero transport errors.
//
// Same Redis contract as every other cache here (Sprint 1.14): own client,
// PRICE_CACHE_KV_*, no-op stub if unset, never throws, fire-and-forget-safe.

import { Redis } from '@upstash/redis';
import { createHash } from 'crypto';
import type { PositionPnLData } from './positionPnl';

// ── Snapshot shape (v1) ────────────────────────────────────────────────────────
// Mirrors EXACTLY what the analytics page renders — see analytics/page.tsx
// selector block. Bump `v` if any field changes meaning (old snapshots are then
// ignored by the version guard below, never mis-rendered).

export interface SnapshotHeader {
  totalPortfolioValue: number;
  totalLpValue: number;
  totalLendingValue: number;
  totalLpFees: number;          // "Unclaimed Fees" card
  totalDailyIncome: number;
  positionsWithFees: number;
  actualAPR: { apr: number; totalValue: number };
  healthScore: number | null;
}

export interface SnapshotFeeIncome {
  totalAllTime: number;
  totalWindow: number;
  series: Array<{ label: string; ts: number; value: number }>;
  protocols: Array<{ protocol: string; chain: string; usd: number; pct: number }>;
  recent: Array<{ ts: number; usd: number; protocol: string; chain: string; dedupeKey: string }>;
  hourlyRate: number;
  dailyAvg: number;
  annualizedAtRate: number;
  peakDay: number;
}

export interface SnapshotLpPnl {
  initialValue: number;
  currentValue: number;
  closingValue: number;
  feesCollected: number;
  feesUnclaimed: number;
  ilUSD: number;
  capitalGL: number;
  netPnl: number;
  netPnlPct: number;
  included: number;
  excluded: number;
  pendingClaimCount: number;
  estimatedPositionCount: number;
}

// Sprint SPOT-RESILIENCE-V2: one closed/open position's last-known-good computed
// P&L, carried in the snapshot so a COLD cross-device load can seed the client's
// per-position LKG cache (app/hooks/useLpPnl.ts) — a transient failure then still
// degrades to STALE instead of dropping the position from totals, even on a
// device that has never loaded this wallet. `data` is the exact PositionPnLData
// computePositionPnL produced (no new calculation — a cache of computed output).
export interface SnapshotPerPositionEntry {
  computedAt: number;
  data: PositionPnLData;
}

export interface AnalyticsSnapshot {
  v: 2;
  computedAt: number;           // ms epoch of the compute that produced it
  header: SnapshotHeader;
  feeIncome: SnapshotFeeIncome;
  lpPnl: SnapshotLpPnl;
  // Sprint SPOT-RESILIENCE-V2 — per-position last-known-good, keyed by pos.id.
  // Optional so a v2 snapshot written without it (or an empty map) still
  // validates; consumers treat a missing map as "no per-position seed".
  perPosition?: Record<string, SnapshotPerPositionEntry>;
}

// ── Key: sha256 of the canonical wallet-set string ────────────────────────────
// The CLIENT builds the canonical string (chain-prefixed, per-chain-normalized,
// sorted, comma-joined — see analytics/page.tsx walletSetKey memo) so client and
// server agree byte-for-byte; the server only hashes it. A different wallet set
// (added/removed watched wallet, connect/disconnect) is a different snapshot.
// Sprint SPOT-RESILIENCE-V2: key bumped v1 → v2 alongside the `v:2` shape (added
// perPosition). Old v1 blobs live under the v1 key and are simply never read
// again — no risk of mis-rendering a v1 shape as v2. The `v` field guard below
// is the belt-and-braces second check.
const SNAPSHOT_CACHE_VERSION = 'analytics_snapshot_v2';
const SNAPSHOT_TTL_SECONDS = 24 * 60 * 60; // hard staleness ceiling (policy above)
// Raised from 512 KB: the per-position map (Sprint SPOT-RESILIENCE-V2) adds ~30
// numeric fields per position; 1 MB comfortably holds a many-position wallet.
const MAX_SNAPSHOT_BYTES = 1024 * 1024;    // sanity cap — reject runaway payloads

function snapshotKey(walletSet: string): string {
  const hash = createHash('sha256').update(walletSet).digest('hex').slice(0, 32);
  return `${SNAPSHOT_CACHE_VERSION}:${hash}`;
}

// ── Redis (Sprint 1.14 contract) ──────────────────────────────────────────────
const _redisUrl = process.env.PRICE_CACHE_KV_REST_API_URL;
const _redisToken = process.env.PRICE_CACHE_KV_REST_API_TOKEN;
let _redis: Redis | null = null;
if (_redisUrl && _redisToken) {
  try { _redis = new Redis({ url: _redisUrl, token: _redisToken }); }
  catch (err) { console.warn('[analyticsSnapshot] Redis client construction failed; no-op stub:', err); _redis = null; }
}

function isValidSnapshot(s: unknown): s is AnalyticsSnapshot {
  const x = s as AnalyticsSnapshot;
  return !!x && x.v === 2
    && typeof x.computedAt === 'number'
    && !!x.header && typeof x.header.totalPortfolioValue === 'number'
    && !!x.feeIncome && typeof x.feeIncome.totalAllTime === 'number' && Array.isArray(x.feeIncome.series)
    && !!x.lpPnl && typeof x.lpPnl.capitalGL === 'number'
    // perPosition is OPTIONAL, but if present it must be an object (not array/null).
    && (x.perPosition == null || (typeof x.perPosition === 'object' && !Array.isArray(x.perPosition)));
}

export async function readAnalyticsSnapshot(walletSet: string): Promise<AnalyticsSnapshot | null> {
  if (!_redis || !walletSet) return null;
  try {
    const raw = await _redis.get<AnalyticsSnapshot | string | null>(snapshotKey(walletSet));
    if (raw == null) return null;
    const snap = typeof raw === 'string' ? (JSON.parse(raw) as AnalyticsSnapshot) : raw;
    return isValidSnapshot(snap) ? snap : null;
  } catch { return null; }
}

// Write ONLY a complete compute's output (the route enforces shape; the client
// enforces "settled cleanly"). Returns whether the write was accepted.
export async function writeAnalyticsSnapshot(walletSet: string, snapshot: AnalyticsSnapshot): Promise<boolean> {
  if (!_redis || !walletSet || !isValidSnapshot(snapshot)) return false;
  const body = JSON.stringify(snapshot);
  if (body.length > MAX_SNAPSHOT_BYTES) {
    console.warn(`[analyticsSnapshot] rejected oversize snapshot (${body.length} bytes)`);
    return false;
  }
  try {
    await _redis.set(snapshotKey(walletSet), body, { ex: SNAPSHOT_TTL_SECONDS });
    return true;
  } catch { return false; }
}
