"use client";

import { useParams, useSearchParams } from "next/navigation";
import { useState, useEffect, useMemo, useRef, Suspense, type CSSProperties } from "react";
import Link from "next/link";
import TerminalNavbar from "../../../components/TerminalNavbar";
import { usePositions } from "../../../contexts/PositionsContext";
import { useWatchedWallets, type WatchedWalletChain } from "../../../contexts/WatchedWalletsContext";
import type { AerodromePosition } from "../../../lib/aerodrome";
import { getTokenLogo, TOKEN_COLORS } from "../../../lib/tokenLogos";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { usePositionActivity } from "../../../hooks/usePositionActivity";
import { useBluefinActivity } from "../../../hooks/useBluefinActivity";
import { useOrcaActivity } from "../../../hooks/useOrcaActivity";
import { useRaydiumActivity } from "../../../hooks/useRaydiumActivity";
import { useHyperSwapActivity } from "../../../hooks/useHyperSwapActivity";
import { useUniswapActivity } from "../../../hooks/useUniswapActivity";
import { useVelodromeActivity } from "../../../hooks/useVelodromeActivity";
import { usePancakeSwapActivity } from "../../../hooks/usePancakeSwapActivity";
import { useCetusActivity } from "../../../hooks/useCetusActivity";
import { computePositionPnL } from "../../../lib/positionPnl";
import { computePositionProjection } from "../../../lib/positionProjections";
import InfoTooltip from "../../../components/InfoTooltip";

// ── Scan-mode URL sync ───────────────────────────────────────────────────────
// Row clicks on the dashboard navigate with window.location.href — a FULL page
// load, which discards the in-memory scanAddress. Without this, a user who
// pasted a wallet could see positions but opening ANY of them (every protocol,
// not just wrappers) rendered "Position not found" with the navbar reading
// "no wallet". Same class of gap as the analytics one fixed in e85f794, and
// the same remedy: restore the scan identity from ?address=&chain=.
//
// Semantics deliberately match AnalyticsScanModeListener, NOT the dashboard's:
// ABSENT params must NOT clear an active scan. Only the dashboard (which owns
// the scan banner and its [X] dismiss) may clear it.
//
// Isolated in its own component + <Suspense> because useSearchParams() opts the
// subtree into client-side rendering (Next.js 16 requirement).
function PositionScanModeListener() {
  const searchParams = useSearchParams();
  const { setScanAddress } = useWatchedWallets();
  const lastSigRef = useRef<string | null>(null);
  useEffect(() => {
    const addr = searchParams?.get("address") ?? null;
    const chainParam = searchParams?.get("chain") ?? null;
    const sig = `${addr}|${chainParam}`;
    if (lastSigRef.current === sig) return;
    lastSigRef.current = sig;
    if (addr && chainParam && (chainParam === "evm" || chainParam === "solana" || chainParam === "sui")) {
      setScanAddress({ address: addr, chain: chainParam as WatchedWalletChain });
    }
  }, [searchParams, setScanAddress]);
  return null;
}

// ── Terminal palette (matches position.html exactly) ─────────────────────────
const C = {
  bg:         "var(--bg)",
  bg1:        "var(--surface)",
  bg2:        "var(--surface)",
  bg3:        "var(--surface)",
  bg4:        "var(--surface-2)",
  border:     "var(--line)",
  borderHi:   "var(--line-strong)",
  text:       "var(--fg-muted)",
  textMid:    "#b0b0b0",
  textBright: "var(--fg)",
  textWhite:  "var(--fg)",
  green:      "var(--accent)",
  greenDim:   "var(--accent-hover)",
  greenFaint: "color-mix(in srgb, var(--accent) 6%, transparent)",
  greenGlow:  "color-mix(in srgb, var(--accent) 18%, transparent)",
  cyan:       "var(--info)",
  cyanFaint:  "color-mix(in srgb, var(--info) 7%, transparent)",
  red:        "var(--neg)",
  redFaint:   "color-mix(in srgb, var(--neg) 7%, transparent)",
  amber:      "var(--warn)",
  purple:     "var(--chain-solana)",
  blue:       "var(--info)",
} as const;

const FONT = "'JetBrains Mono','Courier New',monospace";

// ── Token logo circle ─────────────────────────────────────────────────────────
function TokenCircle({
  symbol, size = 44, style,
}: { symbol: string; size?: number; style?: CSSProperties }) {
  const [imgErr, setImgErr] = useState(false);
  const logoUrl = getTokenLogo(symbol);
  const color = TOKEN_COLORS[symbol] ?? TOKEN_COLORS[symbol.toUpperCase()] ?? "#3d3d3d";
  const base: CSSProperties = {
    width: size, height: size, borderRadius: "50%",
    border: `1px solid ${C.borderHi}`, flexShrink: 0, background: C.bg2, ...style,
  };
  if (logoUrl && !imgErr) {
    return <img src={logoUrl} alt={symbol} onError={() => setImgErr(true)}
      style={{ ...base, objectFit: "cover", display: "block" }} />;
  }
  return (
    <div style={{
      ...base, background: color,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.22, fontWeight: 700, color: C.textWhite, letterSpacing: "0.04em",
    }}>
      {symbol.length <= 4 ? symbol.toUpperCase() : symbol.slice(0, 4).toUpperCase()}
    </div>
  );
}

// ── Fee-snapshot localStorage helpers (unchanged) ────────────────────────────
const FEE_LS_KEY = "defidesh-fee-history";
const MIN_SNAPSHOT_MS = 5 * 60 * 1000;

interface FeeSnapshot {
  timestamp: number;
  feesUSD: number;
  fees0?: number;
  fees1?: number;
}

function loadSnapshots(posId: string): FeeSnapshot[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(FEE_LS_KEY);
    if (!raw) return [];
    return (JSON.parse(raw) as Record<string, FeeSnapshot[]>)[posId] ?? [];
  } catch { return []; }
}

function appendSnapshot(posId: string, snap: FeeSnapshot): FeeSnapshot[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(FEE_LS_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, FeeSnapshot[]>) : {};
    const existing = all[posId] ?? [];
    const last = existing[existing.length - 1];
    if (last && snap.timestamp - last.timestamp < MIN_SNAPSHOT_MS) return existing;
    const updated = [...existing, snap].slice(-1000);
    all[posId] = updated;
    localStorage.setItem(FEE_LS_KEY, JSON.stringify(all));
    return updated;
  } catch { return []; }
}

// ── Constants ─────────────────────────────────────────────────────────────────
const STABLES = new Set(["USDC", "USDT", "DAI", "USDbC", "USDC.e", "USDS"]);

// ── Helpers ───────────────────────────────────────────────────────────────────
function effectiveStatus(p: AerodromePosition): "In Range" | "Out of Range" | "Closed" {
  if (p.value === 0 && p.fees === 0) return "Closed";
  return p.status as "In Range" | "Out of Range";
}

function getManageUrl(protocol: string): string {
  // Match by PROTOCOL NAME (substring) so any pair on a given protocol routes
  // to the right management URL. To add a new protocol, append one line below.
  if (protocol.includes("Aerodrome"))  return "https://aerodrome.finance/dash";
  if (protocol.includes("Velodrome"))  return "https://velodrome.finance/dash";
  if (protocol.includes("Uniswap"))    return "https://app.uniswap.org/pool";
  if (protocol.includes("Orca"))       return "https://www.orca.so/portfolio";
  if (protocol.includes("Raydium"))    return "https://raydium.io/portfolio/";
  if (protocol.includes("Bluefin"))    return "https://trade.bluefin.io/liquidity-pools";
  if (protocol.includes("Cetus"))      return "https://app.cetus.zone/pools?tab=positions";
  if (protocol.includes("Momentum"))   return "https://app.mmt.finance";
  if (protocol.includes("HyperSwap"))  return "https://app.hyperswap.fi/pool";
  if (protocol.includes("KittenSwap")) return "https://www.kittenswap.org";
  if (protocol.includes("ProjectX") || protocol.includes("PRJX")) return "https://www.prjx.com/portfolio";
  if (protocol.includes("PancakeSwap")) return "https://pancakeswap.finance/liquidity";
  return "";
}

function fmtLarge(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function tickToUSD(tick: number, pos: AerodromePosition): number | null {
  const d0 = pos.token0Decimals ?? 18;
  const d1 = pos.token1Decimals ?? 6;
  try {
    const raw = Math.pow(1.0001, tick) * Math.pow(10, d0 - d1);
    if (!isFinite(raw) || raw <= 0) return null;
    if (STABLES.has(pos.token1Symbol ?? "")) return raw;
    if (STABLES.has(pos.token0Symbol ?? "")) {
      const inv = 1 / raw;
      return isFinite(inv) && inv > 0 ? inv : null;
    }
    if (pos.price1 && pos.price1 > 0) return raw * pos.price1;
    return raw;
  } catch { return null; }
}

function fmtPrice(n: number): string {
  if (n >= 1_000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (n >= 1)     return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (n >= 0.0001) return `$${n.toFixed(6)}`;
  return `$${n.toExponential(2)}`;
}

function fmt$(n: number, dec = 2): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;
}

function getCurrentPrice(pos: AerodromePosition): number | null {
  if (STABLES.has(pos.token1Symbol ?? "")) return pos.price0 ?? null;
  if (STABLES.has(pos.token0Symbol ?? "")) return pos.price1 ?? null;
  return pos.price0 ?? null;
}

function chainColor(chain: string): string {
  const map: Record<string, string> = {
    Base: C.blue, Ethereum: C.cyan, Arbitrum: C.green, Optimism: "var(--chain-optimism)",
    Polygon: C.purple, Avalanche: "var(--chain-avalanche)", Solana: C.purple, Sui: C.blue,
    HyperEVM: "var(--pos)", "BNB Chain": C.amber,
  };
  return map[chain] ?? C.green;
}

// ── Section frame ────────────────────────────────────────────────────────────
function Section({
  icon, title, sub, right, children,
}: {
  icon: string;
  title: string;
  sub?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section style={{ borderBottom: `1px solid ${C.border}`, animation: "_fadeUp 0.45s ease both" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "24px 40px 0", marginBottom: 18, gap: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
          <span style={{ fontSize: 14, color: C.green, letterSpacing: "0.1em" }}>{icon}</span>
          <div>
            <div style={{ fontSize: 15.5, fontWeight: 700, color: C.textBright, letterSpacing: "0.18em", textTransform: "uppercase" }}>
              {title}
            </div>
            {sub && <div style={{ fontSize: 14, color: C.text, opacity: 0.55, marginTop: 4 }}>{sub}</div>}
          </div>
        </div>
        {right && <div style={{ marginRight: 0 }}>{right}</div>}
      </div>
      {children}
    </section>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function PositionDetail() {
  const params = useParams();
  const { positions, isLoading } = usePositions();

  const rawId = typeof params.id === "string" ? params.id : Array.isArray(params.id) ? params.id[0] : "";
  const posId = decodeURIComponent(rawId);
  const pos   = positions.find((p) => p.id === posId) ?? null;

  // "Back to dashboard" must preserve an active scan. The DASHBOARD's own
  // listener CLEARS scanAddress when ?address=&chain= are absent (it owns the
  // scan banner and its [X] dismiss), so a bare /dashboard href would drop the
  // user's pasted wallet and land them on an empty dashboard. Outside scan
  // mode this is the empty string and the hrefs are unchanged.
  const { scanAddress } = useWatchedWallets();
  const backHref = scanAddress
    ? `/dashboard?address=${encodeURIComponent(scanAddress.address)}&chain=${encodeURIComponent(scanAddress.chain)}`
    : "/dashboard";

  // ── Derived data ────────────────────────────────────────────────────────────
  const posStatus  = pos ? effectiveStatus(pos) : "Closed";
  const isClosed   = posStatus === "Closed";
  const manageUrl  = pos ? getManageUrl(pos.protocol) : "";

  const t0  = pos?.token0Symbol ?? "Token0";
  const t1  = pos?.token1Symbol ?? "Token1";

  // Price range
  // NOTE: when token0 is stable (USDC), tickToUSD returns `1/raw` — the
  // inversion FLIPS the price ordering vs the tick ordering: higher tick →
  // LOWER inverted price. So for inverted-stable pools (e.g. Cetus's
  // canonical USDC/SUI where USDC=token0), tickLower actually produces the
  // maximum USD price and tickUpper produces the minimum — the bug the
  // user reported as "Cetus range bar shows max < current". Take
  // Math.min/max so the labels reflect the actual numeric ordering
  // regardless of which token is stable. Non-inverted pools (WETH/USDC
  // with USDC=token1, Aerodrome/Velodrome/Uniswap) have tickLower<tickUpper
  // → rawLower<rawUpper already, so this is a no-op for them.
  const hasRange    = pos != null && pos.tickLower != null && pos.tickUpper != null;
  const priceAtLowerTick = hasRange && pos ? tickToUSD(pos.tickLower!, pos) : null;
  const priceAtUpperTick = hasRange && pos ? tickToUSD(pos.tickUpper!, pos) : null;
  const minPriceUSD = priceAtLowerTick != null && priceAtUpperTick != null
    ? Math.min(priceAtLowerTick, priceAtUpperTick)
    : priceAtLowerTick;
  const maxPriceUSD = priceAtLowerTick != null && priceAtUpperTick != null
    ? Math.max(priceAtLowerTick, priceAtUpperTick)
    : priceAtUpperTick;
  const curPriceUSD = pos ? getCurrentPrice(pos) : null;

  // Range-bar fill percentage. The previous Math.max(2, Math.min(98, …))
  // clamp kept the marker tick visible inside the bar bounds, but it also
  // capped fill at 98% when price exceeded max and floored at 2% when price
  // dropped below min — wrong for out-of-range states. New rule:
  //   below range  → 0   (empty bar, amber pulse at left tip)
  //   above range  → 100 (full green bar, amber pulse at right tip)
  //   in range     → proportional 0..100
  let rangeBarPct = 50;
  let isOutOfRangeBelow = false;
  let isOutOfRangeAbove = false;
  if (minPriceUSD !== null && maxPriceUSD !== null && curPriceUSD !== null && maxPriceUSD > minPriceUSD) {
    if (curPriceUSD <= minPriceUSD) {
      rangeBarPct = 0;
      isOutOfRangeBelow = true;
    } else if (curPriceUSD >= maxPriceUSD) {
      rangeBarPct = 100;
      isOutOfRangeAbove = true;
    } else {
      rangeBarPct = ((curPriceUSD - minPriceUSD) / (maxPriceUSD - minPriceUSD)) * 100;
    }
  }

  const rangeWidthPct = (minPriceUSD && maxPriceUSD && minPriceUSD > 0)
    ? ((maxPriceUSD - minPriceUSD) / minPriceUSD * 100).toFixed(2)
    : null;

  const distLower = (minPriceUSD && curPriceUSD && curPriceUSD > 0)
    ? ((minPriceUSD - curPriceUSD) / curPriceUSD * 100).toFixed(1)
    : null;
  const distUpper = (maxPriceUSD && curPriceUSD && curPriceUSD > 0)
    ? ((maxPriceUSD - curPriceUSD) / curPriceUSD * 100).toFixed(1)
    : null;

  // APR / cashflow
  const hasApr     = (pos?.apy ?? 0) > 0 && (pos?.value ?? 0) > 0;
  const dailyUSD   = hasApr ? pos!.value * pos!.apy / 100 / 365 : null;
  const weeklyUSD  = hasApr ? pos!.value * pos!.apy / 100 / 52  : null;
  const monthlyUSD = hasApr ? pos!.value * pos!.apy / 100 / 12  : null;
  const yearlyUSD  = hasApr ? pos!.value * pos!.apy / 100       : null;

  // Amounts
  const hasAmounts = pos != null && (pos.amount0 != null || pos.amount1 != null);
  const hasFees    = pos != null && (pos.fees0 != null || pos.fees1 != null);

  // ── Fee tracking (unused chart historical fallback, retained for snapshot side-effect parity) ──
  const [, setSnapshots] = useState<FeeSnapshot[]>([]);
  void loadSnapshots;

  // ── Pool statistics (from DefiLlama) ────────────────────────────────────────
  const [poolStats, setPoolStats] = useState<{ tvlUsd: number | null; volumeUsd1d: number | null; feesUsd1d: number | null } | null>(null);
  const [poolStatsLoading, setPoolStatsLoading] = useState(false);

  // Performance-metrics timeframe toggle. Default Y (yearly) — Actual /
  // Estimated APR are stored as annual rates so Y shows them as-is; D/W/M
  // divide. Actual Daily Income is stored as a per-day rate so the same
  // toggle multiplies it. Fee Income Rate is stored as a 30-day-derived
  // (i.e. monthly) percentage, so the toggle scales it from the M base.
  // The state lives ONLY in this section and never feeds back into any
  // data fetch or calculation — pure display transform.
  const [aprView, setAprView] = useState<"D" | "W" | "M" | "Y">("Y");
  const APR_DIVISOR:        Record<typeof aprView, number> = { D: 365, W: 52,  M: 12, Y: 1   };
  const INCOME_MULTIPLIER:  Record<typeof aprView, number> = { D: 1,   W: 7,   M: 30, Y: 365 };
  const FEE_RATE_FROM_30D:  Record<typeof aprView, number> = { D: 1/30, W: 7/30, M: 1, Y: 365/30 };
  const INCOME_SUFFIX:      Record<typeof aprView, string> = { D: "/day", W: "/week", M: "/month", Y: "/year" };
  const INCOME_LABEL:       Record<typeof aprView, string> = { D: "Actual Daily Income", W: "Actual Weekly Income", M: "Actual Monthly Income", Y: "Actual Annual Income" };
  const FEE_PERIOD_LABEL:   Record<typeof aprView, string> = { D: "(1d)", W: "(7d)", M: "(30d)", Y: "(365d)" };

  useEffect(() => {
    if (!pos) return;
    setPoolStatsLoading(true);
    const params = new URLSearchParams({ protocol: pos.protocol, chain: pos.chain, pair: pos.pair });
    fetch(`/api/pool-stats?${params.toString()}`)
      .then(r => r.json())
      .then(data => { setPoolStats(data); setPoolStatsLoading(false); })
      .catch(() => setPoolStatsLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos?.id]);

  // Snapshot fee history on every refresh (still used for legacy listeners)
  useEffect(() => {
    if (!pos) return;
    const snap: FeeSnapshot = {
      timestamp: Date.now(),
      feesUSD: pos.fees,
      fees0: pos.fees0,
      fees1: pos.fees1,
    };
    const updated = appendSnapshot(pos.id, snap);
    setSnapshots(updated);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos?.id, pos?.fees]);

  // ── Activity data (on-chain fee claim history) ───────────────────────────
  const HYPEREVM_PROTOCOLS = new Set(['HyperSwap', 'KittenSwap', 'ProjectX']);
  const isHyperEVM = pos ? HYPEREVM_PROTOCOLS.has(pos.protocol) : false;

  const aeroTokenId = pos?.protocol === 'Aerodrome' ? pos.id.replace('aero-', '') : null;
  const { data: aeroActivity, isLoading: aeroActivityLoading, error: aeroActivityError } = usePositionActivity(
    aeroTokenId, pos?.token0Decimals ?? 18, pos?.token1Decimals ?? 18,
    pos?.token0Address, pos?.token1Address, pos?.price0, pos?.price1,
    pos?.tickLower, pos?.tickUpper,
  );

  const bluefinObjId = pos?.protocol === 'Bluefin' ? pos.id.replace('bluefin-', '') : null;
  const { data: bluefinActivity, isLoading: bluefinActivityLoading, error: bluefinActivityError } = useBluefinActivity(
    bluefinObjId, pos?.token0Decimals ?? 9, pos?.token1Decimals ?? 6,
    pos?.coinTypeA, pos?.coinTypeB, pos?.price0, pos?.price1, pos?.walletAddress,
    pos?.tickLower, pos?.tickUpper,
  );

  const orcaPosId = pos?.protocol === 'Orca' ? pos.id.replace('orca-', '') : null;
  const { data: orcaActivity, isLoading: orcaActivityLoading, error: orcaActivityError } = useOrcaActivity(
    orcaPosId, pos?.token0Decimals ?? 9, pos?.token1Decimals ?? 6,
    pos?.token0Address, pos?.token1Address, pos?.price0, pos?.price1, pos?.walletAddress,
    pos?.tickLower, pos?.tickUpper,
  );

  const raydiumPosId = pos?.protocol === 'Raydium' ? pos.id.replace('ray-', '') : null;
  const { data: raydiumActivity, isLoading: raydiumActivityLoading, error: raydiumActivityError } = useRaydiumActivity(
    raydiumPosId, pos?.token0Decimals ?? 9, pos?.token1Decimals ?? 6,
    pos?.token0Address, pos?.token1Address, pos?.price0, pos?.price1, pos?.walletAddress,
    pos?.tickLower, pos?.tickUpper,
  );

  const hyperswapTokenId = pos && HYPEREVM_PROTOCOLS.has(pos.protocol)
    ? pos.id.replace(/^hyperswap-[^-]+-/, '')
    : null;
  const { data: hyperswapActivity, isLoading: hyperswapActivityLoading, error: hyperswapActivityError } = useHyperSwapActivity(
    hyperswapTokenId, pos && HYPEREVM_PROTOCOLS.has(pos.protocol) ? pos.protocol : null,
    pos?.token0Decimals ?? 18, pos?.token1Decimals ?? 6,
    pos?.token0Address, pos?.token1Address, pos?.price0, pos?.price1,
    pos?.tickLower, pos?.tickUpper,
  );

  const uniswapPosId = pos?.protocol === 'Uniswap V3' ? pos.id : null;
  const { data: uniswapActivity, isLoading: uniswapActivityLoading, error: uniswapActivityError } = useUniswapActivity(
    uniswapPosId, pos?.token0Decimals ?? 18, pos?.token1Decimals ?? 18,
    pos?.token0Address, pos?.token1Address, pos?.price0, pos?.price1,
    pos?.tickLower, pos?.tickUpper,
  );

  const velodromePosId = pos?.protocol === 'Velodrome' ? pos.id.replace('velo-', '') : null;
  const { data: velodromeActivity, isLoading: velodromeActivityLoading, error: velodromeActivityError } = useVelodromeActivity(
    velodromePosId, pos?.token0Decimals ?? 18, pos?.token1Decimals ?? 18,
    pos?.token0Address, pos?.token1Address, pos?.price0, pos?.price1,
    pos?.tickLower, pos?.tickUpper,
  );

  const pancakeTokenId = pos?.protocol === 'PancakeSwap V3' ? pos.id.replace('cake3-bsc-', '') : null;
  const { data: pancakeActivity, isLoading: pancakeActivityLoading } = usePancakeSwapActivity(
    pancakeTokenId, pos?.token0Decimals ?? 18, pos?.token1Decimals ?? 18,
    pos?.token0Address, pos?.token1Address, pos?.price0, pos?.price1,
    pos?.tickLower, pos?.tickUpper,
  );

  const cetusObjId = pos?.protocol === 'Cetus' ? pos.id.replace('cetus-', '') : null;
  const { data: cetusActivity, isLoading: cetusActivityLoading, error: cetusActivityError } = useCetusActivity(
    cetusObjId, pos?.token0Decimals ?? 9, pos?.token1Decimals ?? 6,
    pos?.coinTypeA, pos?.coinTypeB, pos?.price0, pos?.price1, pos?.walletAddress,
    pos?.tickLower, pos?.tickUpper,
  );

  const activity = pos?.protocol === 'Aerodrome' ? aeroActivity
    : pos?.protocol === 'Bluefin' ? bluefinActivity
    : pos?.protocol === 'Cetus' ? cetusActivity
    : pos?.protocol === 'Orca' ? orcaActivity
    : pos?.protocol === 'Raydium' ? raydiumActivity
    : isHyperEVM ? hyperswapActivity
    : pos?.protocol === 'Uniswap V3' ? uniswapActivity
    : pos?.protocol === 'Velodrome' ? velodromeActivity
    : pos?.protocol === 'PancakeSwap V3' ? pancakeActivity
    : null;
  const activityLoading = pos?.protocol === 'Aerodrome' ? aeroActivityLoading
    : pos?.protocol === 'Bluefin' ? bluefinActivityLoading
    : pos?.protocol === 'Cetus' ? cetusActivityLoading
    : pos?.protocol === 'Orca' ? orcaActivityLoading
    : pos?.protocol === 'Raydium' ? raydiumActivityLoading
    : isHyperEVM ? hyperswapActivityLoading
    : pos?.protocol === 'Uniswap V3' ? uniswapActivityLoading
    : pos?.protocol === 'Velodrome' ? velodromeActivityLoading
    : pos?.protocol === 'PancakeSwap V3' ? pancakeActivityLoading
    : false;
  const activityError = pos?.protocol === 'Aerodrome' ? aeroActivityError
    : pos?.protocol === 'Bluefin' ? bluefinActivityError
    : pos?.protocol === 'Cetus' ? cetusActivityError
    : pos?.protocol === 'Orca' ? orcaActivityError
    : pos?.protocol === 'Raydium' ? raydiumActivityError
    : isHyperEVM ? hyperswapActivityError
    : pos?.protocol === 'Uniswap V3' ? uniswapActivityError
    : pos?.protocol === 'Velodrome' ? velodromeActivityError
    : null;
  const isActivityProtocol = ['Aerodrome', 'Bluefin', 'Orca', 'Raydium', 'Uniswap V3', 'Velodrome', 'PancakeSwap V3', 'Cetus', 'Momentum'].includes(pos?.protocol ?? '') || isHyperEVM;

  // ── Wrapper-protocol display metadata (Sprint WRAPPER-PROTOCOLS Phase 2 Part 1)
  // Present ONLY on wrapper-held positions (DefiTuna today). Every consumer is
  // display-only: no P&L, valuation, or aggregate reads any of this, so a
  // non-wrapper position is byte-identical to before this block existed.
  const wm = pos?.wrapperMeta ?? null;
  // Distance from the current price to the NEAREST applicable liquidation
  // price, as a percentage. Presentational only. A 0 bound means "this side
  // cannot liquidate" (verified live on DefiTuna) and is excluded, never
  // treated as a $0 liquidation price.
  const liqDistancePct = (() => {
    if (!wm?.currentPrice || wm.currentPrice <= 0) return null;
    const bounds = [wm.liquidationLower, wm.liquidationUpper]
      .filter((b): b is number => typeof b === 'number' && b > 0);
    if (bounds.length === 0) return null;
    const nearest = bounds.reduce((best, b) =>
      Math.abs(b - wm.currentPrice!) < Math.abs(best - wm.currentPrice!) ? b : best);
    return Math.abs((nearest - wm.currentPrice) / wm.currentPrice) * 100;
  })();
  const liqDanger = liqDistancePct != null && liqDistancePct < 10;
  const activityPending = isActivityProtocol && !activity && !activityError;

  // Build fee accumulation chart from on-chain activity fee_claim events.
  const feeChartData = useMemo(() => {
    if (!activity?.events || activity.events.length === 0) return null;

    const chronological = [...activity.events].reverse();
    const feeClaims = chronological.filter(
      (e) => (e.type === 'fee_claim' || e.type === 'reward_claim') && e.timestamp > 0,
    );

    if (feeClaims.length === 0) return { chartData: [] as { label: string; value: number }[], noClaimsYet: true, openTs: 0 };

    const firstDeposit = chronological.find((e) => e.type === 'deposit');
    const openTs = firstDeposit ? firstDeposit.timestamp * 1000 : feeClaims[0].timestamp * 1000;

    let cumulative = 0;
    const chartData: { label: string; value: number }[] = [
      { label: new Date(openTs).toLocaleDateString("en-US", { month: "short", day: "numeric" }), value: 0 },
    ];

    for (const ev of feeClaims) {
      cumulative += ev.usdAtTime ?? 0;
      chartData.push({
        label: new Date(ev.timestamp * 1000).toLocaleDateString("en-US", {
          month: "short", day: "numeric",
        }),
        value: cumulative,
      });
    }

    return { chartData, noClaimsYet: false, openTs };
  }, [activity]);

  // ── Loading state ──────────────────────────────────────────────────────────
  if (isLoading && !pos) {
    return (
      <div style={{ background: C.bg, color: C.text, minHeight: "100vh", fontFamily: FONT, paddingTop: 52 }}>
        <Suspense fallback={null}><PositionScanModeListener /></Suspense>
        <TerminalNavbar />
        <div style={{ padding: 64, textAlign: "center" }}>
          <div style={{
            width: 32, height: 32, border: `2px solid ${C.green}`, borderTopColor: "transparent",
            borderRadius: "50%", margin: "0 auto 16px",
            animation: "_spin 1s linear infinite",
          }} />
          <style>{`@keyframes _spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }`}</style>
          <p style={{ color: C.text, fontSize: 14, letterSpacing: "0.12em", textTransform: "uppercase" }}>Loading position…</p>
        </div>
      </div>
    );
  }

  // ── Not found ──────────────────────────────────────────────────────────────
  if (!pos) {
    return (
      <div style={{ background: C.bg, color: C.text, minHeight: "100vh", fontFamily: FONT, paddingTop: 52 }}>
        {/* Mounted HERE too, and this one is load-bearing: in scan mode the
            page renders "not found" on first paint (positions are empty until
            the scan identity is restored), so the listener must run from
            inside this branch or the page would never recover. */}
        <Suspense fallback={null}><PositionScanModeListener /></Suspense>
        <TerminalNavbar />
        <div style={{ padding: 64, textAlign: "center" }}>
          <h2 style={{ fontSize: 28, fontWeight: 700, color: C.textWhite, marginBottom: 12, letterSpacing: "-0.01em" }}>
            Position not found
          </h2>
          <p style={{ color: C.text, marginBottom: 24, fontSize: 15 }}>
            This position could not be located. It may have been closed or the data hasn&apos;t loaded yet.
          </p>
          <Link href={backHref} style={{
            border: `1px solid ${C.greenDim}`, background: C.greenFaint, color: C.green,
            padding: "10px 18px", textDecoration: "none", fontSize: 14,
            fontFamily: FONT, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 600,
          }}>
            ← Back to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  // ── Derived activity metrics ───────────────────────────────────────────────
  const feeClaims = activity?.events.filter(e => e.type === 'fee_claim' || e.type === 'reward_claim') ?? [];
  const deposits = activity?.events.filter(e => e.type === 'deposit') ?? [];
  const claimedUSD = feeClaims.reduce((sum, e) => {
    if (e.usdAtTime != null) return sum + e.usdAtTime;
    return sum + e.amount0 * (pos.price0 ?? 0) + e.amount1 * (pos.price1 ?? 0);
  }, 0);
  const uncollectedUSD = pos.fees;
  const lifetimeUSD = claimedUSD + uncollectedUSD;
  // Sprint POSITION-DETAIL (Contract invariant (k)): pending REWARD EMISSIONS,
  // read from on-chain rewarder state by the position routes. Folded into the
  // DISPLAYED uncollected total below so it matches the protocol's own
  // claimable UI (e.g. Cetus "Claimable Yield" = fees + emissions). pos.fees
  // itself stays fees-only — analytics aggregation is untouched.
  const pendingRewards = pos.pendingRewards ?? [];
  const rewardsUsd = pos.rewardsUsd ?? 0;
  const totalUncollectedUSD = uncollectedUSD + rewardsUsd;
  const firstDeposit = deposits.length > 0 ? deposits[deposits.length - 1] : null;
  const firstTs = firstDeposit?.timestamp ?? 0;
  const nowTs = Math.floor(Date.now() / 1000);
  const daysActive = firstTs > 0 ? (nowTs - firstTs) / 86400 : 0;
  // Sprint POSITION-DETAIL (B2): when the external pool-APY source has no entry
  // for this pool (pos.apy <= 0 → hasApr false — long-tail pools, Momentum),
  // derive APR from the position's OWN observables instead of showing N/A:
  // (lifetime claimed + uncollected incl. rewards) / age × 365 / value. Works
  // for any pool on any chain with zero per-token configuration. Guarded: a
  // position younger than 24h (or with zero earnings) shows "—" rather than a
  // misleading annualization of hours of data.
  const derivedApr =
    !hasApr && (pos.value ?? 0) > 0 && daysActive >= 1 && (claimedUSD + totalUncollectedUSD) > 0
      ? ((claimedUSD + totalUncollectedUSD) / daysActive) * 365 / pos.value * 100
      : null;
  // Forward projection (Sprint 1.8b): prefer real claims; for new positions with
  // no claim history yet, fall back to an uncollected-fees-based estimate so the
  // metrics aren't dark from day 1. Byte-identical to the prior inline formulas
  // when claims exist (source 'claims'); `projection.source` lets the UI label
  // an uncollected-based estimate honestly (Memory #14).
  const projection = computePositionProjection({
    claimedUSD,
    uncollectedFeesUSD: uncollectedUSD,
    positionValueUSD: pos.value,
    daysActive,
  });
  const actualAPR = projection.actualApr;
  const actualDailyIncome = projection.daily;
  const projFromUncollected = projection.source === 'uncollected';
  const feeIncomePct = pos.value > 0 ? (lifetimeUSD / pos.value) * 100 : 0;
  const daysLabel = daysActive >= 1 ? `${Math.floor(daysActive)}d` : (firstTs > 0 ? '<1d' : '—');
  const openedDate = firstTs > 0 ? new Date(firstTs * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : null;

  // P&L
  const pnlEvents = activity?.events.map((e) => ({
    type: e.type as 'deposit' | 'withdrawal' | 'fee_claim' | 'reward_claim',
    timestamp: e.timestamp as number,
    amount0: e.amount0 as number,
    amount1: e.amount1 as number,
    usdAtTime: (e.usdAtTime as number | null) ?? null,
    price0AtTime: (e.price0AtTime as number | null) ?? null,
    price1AtTime: (e.price1AtTime as number | null) ?? null,
    txHash: e.txHash ?? undefined,
  })) ?? [];
  const pnlResult = isActivityProtocol && activity ? computePositionPnL({
    currentValue: pos.value,
    unclaimedFeesUSD: pos.fees ?? 0,
    price0: pos.price0 ?? 0,
    price1: pos.price1 ?? 0,
    events: pnlEvents,
    isClosed: pos.status === "Closed",
  }) : null;
  const pnl = pnlResult?.ok ? pnlResult.data : null;
  const pnlPositive = pnl ? pnl.netPnlUSD >= 0 : false;
  const ilNegative  = pnl ? pnl.ilUSD < 0 : false;
  const totalFees   = pnl ? pnl.feesCollected + pnl.feesUnclaimed : 0;

  // Tx URL builder
  const txUrl = (hash: string): string => {
    if (pos.chain === 'Sui') return `https://suivision.xyz/txblock/${hash}`;
    if (pos.protocol === 'Orca' || pos.protocol === 'Raydium') return `https://solscan.io/tx/${hash}`;
    if (HYPEREVM_PROTOCOLS.has(pos.protocol)) return `https://hyperevmscan.io/tx/${hash}`;
    if (pos.chain === 'Arbitrum') return `https://arbiscan.io/tx/${hash}`;
    if (pos.chain === 'Polygon')  return `https://polygonscan.com/tx/${hash}`;
    if (pos.chain === 'Optimism') return `https://optimistic.etherscan.io/tx/${hash}`;
    if (pos.chain === 'Ethereum') return `https://etherscan.io/tx/${hash}`;
    if (pos.chain === 'BNB Chain') return `https://bscscan.com/tx/${hash}`;
    return `https://basescan.org/tx/${hash}`;
  };
  const shortHash = (h: string) => h.length > 12 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h;
  const fmtDate = (ts: number) => !ts ? '—' : new Date(ts * 1000).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  });
  const fmtAmt = (n: number) => n === 0 ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 6 });

  // ── Wallet truncation ──────────────────────────────────────────────────────
  const truncWallet = pos.walletAddress
    ? `${pos.walletAddress.slice(0, 6)}…${pos.walletAddress.slice(-4)}`
    : null;

  // Helpers for inline styles
  const cellPadding = "20px 24px";
  const labelStyle: CSSProperties = {
    fontSize: 12, color: C.text, letterSpacing: "0.18em", textTransform: "uppercase",
    marginBottom: 10, opacity: 0.6, fontFamily: FONT,
  };
  const subStyle: CSSProperties = {
    fontSize: 12, color: C.text, marginTop: 5, opacity: 0.6, letterSpacing: "0.04em",
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="pd-page" style={{
      display: "flex",
      flexDirection: "column",
      minHeight: "100vh",
      background: C.bg,
      color: C.text,
      fontFamily: FONT,
      fontSize: 16,
      lineHeight: 1.5,
      overflowX: "hidden",
      // Clear the now-fixed TerminalNavbar (52px tall).
      paddingTop: 52,
    }}>
      <Suspense fallback={null}><PositionScanModeListener /></Suspense>
      <style>{`
        @keyframes _spin   { from { transform:rotate(0deg) } to { transform:rotate(360deg) } }
        @keyframes _pulse  { 0%,100%{opacity:1} 50%{opacity:0.3} }
        @keyframes _fadeUp { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
        @keyframes _scan   { 0%{transform:translateX(-100%)} 100%{transform:translateX(100%)} }
        .pos-row:hover td { background: var(--surface-hover); }
        .btn-neutral:hover { border-color: ${C.text} !important; color: ${C.textBright} !important; background: ${C.bg2} !important; }
        .btn-primary:hover { background: color-mix(in srgb, var(--accent) 12%, transparent) !important; box-shadow: 0 0 14px color-mix(in srgb, var(--accent) 18%, transparent); }
        .tx-link:hover { opacity: 0.7; }
      `}</style>

      <TerminalNavbar />

      <main style={{ flex: 1, background: C.bg }}>

        {/* ── BACK BAR ────────────────────────────────────────────────────── */}
        <div style={{
          padding: "14px 40px",
          borderBottom: `1px solid ${C.border}`,
          display: "flex", alignItems: "center", gap: 14,
        }}>
          <Link href={backHref} style={{
            fontSize: 14, color: C.text, textDecoration: "none",
            letterSpacing: "0.08em", textTransform: "uppercase",
            transition: "color 0.15s",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = C.textMid)}
          onMouseLeave={(e) => (e.currentTarget.style.color = C.text)}
          >
            ← Back to Dashboard
          </Link>
          <span style={{ color: C.borderHi, fontSize: 12 }}>›</span>
          <span style={{ fontSize: 14, color: C.text, letterSpacing: "0.06em" }}>
            <span style={{ color: C.green }}>// position_detail</span> · {pos.id}
          </span>
        </div>

        {/* ── POSITION HEADER ─────────────────────────────────────────────── */}
        <div style={{
          padding: "32px 40px 28px",
          borderBottom: `1px solid ${C.border}`,
          background: `linear-gradient(180deg, ${C.bg1} 0%, ${C.bg} 100%)`,
          position: "relative",
          animation: "_fadeUp 0.4s ease both",
        }}>
          <div aria-hidden style={{
            position: "absolute", top: 0, left: 0, right: 0, height: 1,
            background: `linear-gradient(90deg, transparent, ${C.greenGlow} 30%, ${C.greenGlow} 70%, transparent)`,
            opacity: 0.4,
          }} />
          <div style={{
            fontSize: 12, color: C.text, letterSpacing: "0.22em", textTransform: "uppercase",
            marginBottom: 14, opacity: 0.6,
          }}>
            <span style={{ color: C.green, opacity: 1 }}>// liquidity_position</span> · {pos.protocol.toLowerCase().replace(/ /g, "_")} · {pos.chain.toLowerCase().replace(/ /g, "_")}_network
          </div>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 24, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
              {/* Overlapping token icons */}
              <div style={{ display: "flex", alignItems: "center" }}>
                <TokenCircle symbol={t0} size={44} style={{ position: "relative", zIndex: 2 }} />
                <TokenCircle symbol={t1} size={44} style={{ marginLeft: -14, position: "relative", zIndex: 1 }} />
              </div>
              <div>
                <div style={{ fontSize: 30, fontWeight: 700, color: C.textWhite, letterSpacing: "-0.01em" }}>
                  {t0} / {t1}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
                  {/* Protocol tag */}
                  <span style={{
                    fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase",
                    padding: "4px 12px", border: `1px solid ${C.cyan}4d`, background: C.cyanFaint,
                    color: C.cyan, fontWeight: 600,
                  }}>
                    {pos.protocol}
                  </span>
                  {/* Status tag */}
                  <span style={{
                    fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase",
                    padding: "4px 12px", fontWeight: 600,
                    display: "flex", alignItems: "center", gap: 6,
                    border: `1px solid ${
                      isClosed ? C.borderHi : posStatus === "In Range" ? C.greenDim : C.amber
                    }`,
                    background: isClosed ? C.bg2
                      : posStatus === "In Range" ? C.greenFaint
                      : "color-mix(in srgb, var(--warn) 6%, transparent)",
                    color: isClosed ? C.text
                      : posStatus === "In Range" ? C.green
                      : C.amber,
                  }}>
                    {!isClosed && posStatus === "In Range" && (
                      <span style={{
                        width: 6, height: 6, background: C.green,
                        animation: "_pulse 2s infinite",
                      }} />
                    )}
                    {posStatus}
                  </span>
                  {/* Fee tier tag */}
                  {pos.feeTier != null && (
                    <span style={{
                      fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase",
                      padding: "4px 12px", border: `1px solid ${C.borderHi}`, background: C.bg2,
                      color: C.textMid, fontWeight: 600,
                    }}>
                      {pos.feeTier}% Tier
                    </span>
                  )}
                </div>
                {/* Sub meta row */}
                <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 14, fontSize: 14, color: C.text, letterSpacing: "0.06em", flexWrap: "wrap" }}>
                  <span style={{ color: chainColor(pos.chain), textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 600 }}>
                    ◆ {pos.chain}
                  </span>
                  {truncWallet && (
                    <>
                      <span style={{ color: C.borderHi }}>·</span>
                      <span>wallet <code style={{ color: C.textMid, fontFamily: FONT }}>{truncWallet}</code></span>
                    </>
                  )}
                  {openedDate && (
                    <>
                      <span style={{ color: C.borderHi }}>·</span>
                      <span>
                        Opened <strong style={{ color: C.textMid, fontWeight: 600 }}>{openedDate}</strong>
                        {daysLabel !== '—' && (
                          <> · <span style={{ color: C.green }}>{daysLabel} active</span></>
                        )}
                      </span>
                    </>
                  )}
                </div>
              </div>
            </div>
            {/* Actions */}
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              {manageUrl && (
                <a href={manageUrl} target="_blank" rel="noopener noreferrer"
                  className="btn-primary"
                  style={{
                    fontFamily: FONT, fontSize: 14, fontWeight: 600,
                    letterSpacing: "0.1em", textTransform: "uppercase",
                    padding: "10px 18px",
                    border: `1px solid ${C.greenDim}`, background: C.greenFaint,
                    color: C.green, textDecoration: "none",
                    display: "flex", alignItems: "center", gap: 8,
                    cursor: "pointer", transition: "all 0.15s",
                  }}>
                  ↗ Manage Position
                </a>
              )}
            </div>
          </div>
        </div>

        {/* ── TOP STAT STRIP (4 cells) ──────────────────────────────────── */}
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(4, 1fr)",
          borderBottom: `1px solid ${C.border}`,
          animation: "_fadeUp 0.5s ease 0.05s both",
        }}>
          {/* Total Value */}
          <div style={{ padding: "24px 28px", borderRight: `1px solid ${C.border}`, position: "relative", background: C.bg }}>
            <div style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 5, height: 5, background: C.green }} />
              Total Value
            </div>
            <div style={{ fontSize: 32, fontWeight: 700, letterSpacing: "-0.02em", color: C.textWhite, fontVariantNumeric: "tabular-nums" }}>
              {fmt$(pos.value)}
            </div>
            <div style={{ ...subStyle, opacity: 0.7 }}>live mark-to-market</div>
          </div>
          {/* Uncollected (trading fees + pending reward emissions — invariant (k),
              matches the protocol's own claimable total) */}
          <div style={{ padding: "24px 28px", borderRight: `1px solid ${C.border}`, background: C.bg }}>
            <div style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 5, height: 5, background: C.green }} />
              {rewardsUsd > 0 ? "Uncollected" : "Uncollected Fees"}
            </div>
            <div style={{
              fontSize: 32, fontWeight: 700, letterSpacing: "-0.02em",
              color: totalUncollectedUSD > 0 ? C.green : C.text,
              textShadow: totalUncollectedUSD > 0 ? "0 0 20px color-mix(in srgb, var(--accent) 25%, transparent)" : "none",
              fontVariantNumeric: "tabular-nums",
            }}>
              {fmt$(totalUncollectedUSD)}
            </div>
            <div style={{ ...subStyle, color: totalUncollectedUSD > 0 ? C.green : C.text }}>
              {rewardsUsd > 0 ? "fees + rewards · ready to collect" : totalUncollectedUSD > 0 ? "↑ ready to collect" : "no fees pending"}
            </div>
          </div>
          {/* Estimated APR — pool APY when the external source has it; otherwise
              derived from the position's own earnings (B2 fallback, any pool any
              chain); "—" while too young to annualize honestly. */}
          <div style={{ padding: "24px 28px", borderRight: `1px solid ${C.border}`, background: C.bg }}>
            <div style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 5, height: 5, background: C.green }} />
              Estimated APR
            </div>
            <div style={{
              fontSize: 32, fontWeight: 700, letterSpacing: "-0.02em",
              color: hasApr || derivedApr != null ? C.cyan : C.text,
              textShadow: hasApr || derivedApr != null ? "0 0 16px color-mix(in srgb, var(--info) 20%, transparent)" : "none",
              fontVariantNumeric: "tabular-nums",
            }}>
              {hasApr ? `+${pos.apy.toFixed(1)}%` : derivedApr != null ? `~${derivedApr.toFixed(1)}%` : "—"}
            </div>
            <div style={subStyle}>
              {hasApr ? "based on pool APY" : derivedApr != null ? "derived from position earnings" : "too early to estimate"}
            </div>
          </div>
          {/* Est. Cashflow (mini list) */}
          <div style={{ padding: "24px 28px", background: C.bg }}>
            <div style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 5, height: 5, background: C.green }} />
              Est. Cashflow
            </div>
            {hasApr ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 2 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}>
                  <span style={{ color: C.text, opacity: 0.6 }}>Daily</span>
                  <span style={{ color: C.green, fontWeight: 600 }}>+{fmt$(dailyUSD!)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}>
                  <span style={{ color: C.text, opacity: 0.6 }}>Monthly</span>
                  <span style={{ color: C.green, fontWeight: 600 }}>+{fmt$(monthlyUSD!)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}>
                  <span style={{ color: C.text, opacity: 0.6 }}>Yearly</span>
                  <span style={{ color: C.green, fontWeight: 600 }}>+{fmt$(yearlyUSD!)}</span>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 20, color: C.text, opacity: 0.5, fontStyle: "italic" }}>N/A</div>
            )}
          </div>
        </div>

        {/* ── LEVERAGE & LIQUIDATION (wrapper protocols) ────────────────── */}
        {/* Display-only. Every figure is passed through from the wrapper's own
            API via wrapperMeta; the only arithmetic here is the liquidation
            DISTANCE percentage, which is presentational and feeds nothing. The
            headline equity reads `pos.value` — the exact number the dashboard
            row renders — so list and detail views cannot disagree. */}
        {wm && (
          <Section
            icon="[⚠]"
            title="Leverage & Liquidation"
            sub={`Position managed by ${wm.protocolName} — you own the equity, not the gross LP value`}
          >
            <div style={{ margin: "0 40px" }}>
              {/* What you own / owe */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", border: `1px solid ${C.border}` }}>
                {[
                  { label: "Your Equity", val: fmt$(pos.value), color: C.green,
                    sub: "what you own (total − debt)" },
                  { label: "Borrowed (Debt)", val: wm.debtUSD != null ? fmt$(wm.debtUSD) : "—", color: C.red,
                    sub: "current, incl. accrued interest" },
                  { label: "Gross LP Value", val: wm.totalUSD != null ? fmt$(wm.totalUSD) : "—", color: C.textBright,
                    sub: "equity + debt — NOT your value" },
                  { label: "Leverage", val: wm.leverage != null ? `${wm.leverage.toFixed(2)}×` : "—", color: C.amber,
                    sub: wm.collateralUSD != null ? `on ${fmt$(wm.collateralUSD)} collateral` : "—" },
                ].map((c, i, arr) => (
                  <div key={c.label} style={{
                    padding: "20px 24px",
                    borderRight: i === arr.length - 1 ? "none" : `1px solid ${C.border}`,
                  }}>
                    <div style={{ fontSize: 11, color: C.text, letterSpacing: "0.1em", marginBottom: 8, textTransform: "uppercase" }}>{c.label}</div>
                    <div style={{ fontSize: 22, color: c.color, fontWeight: 700, marginBottom: 6 }}>{c.val}</div>
                    <div style={{ fontSize: 11, color: C.text, opacity: 0.55 }}>{c.sub}</div>
                  </div>
                ))}
              </div>

              {/* Liquidation proximity — the number that matters most here */}
              <div style={{ marginTop: 18, border: `1px solid ${liqDanger ? C.red : C.border}`, background: liqDanger ? C.redFaint : "transparent" }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))" }}>
                  {[
                    { label: "Entry Price", val: wm.entryPrice != null ? fmtPrice(wm.entryPrice) : "—" },
                    { label: "Current Price", val: wm.currentPrice != null ? fmtPrice(wm.currentPrice) : "—" },
                    { label: "Liq. Price (lower)", val: wm.liquidationLower ? fmtPrice(wm.liquidationLower) : "n/a" },
                    { label: "Liq. Price (upper)", val: wm.liquidationUpper ? fmtPrice(wm.liquidationUpper) : "n/a" },
                  ].map((c, i, arr) => (
                    <div key={c.label} style={{
                      padding: "18px 24px",
                      borderRight: i === arr.length - 1 ? "none" : `1px solid ${C.border}`,
                    }}>
                      <div style={{ fontSize: 11, color: C.text, letterSpacing: "0.1em", marginBottom: 8, textTransform: "uppercase" }}>{c.label}</div>
                      <div style={{ fontSize: 17, color: C.textBright, fontWeight: 600 }}>{c.val}</div>
                    </div>
                  ))}
                </div>
                {liqDistancePct != null && (
                  <div style={{
                    padding: "14px 24px",
                    borderTop: `1px solid ${liqDanger ? C.red : C.border}`,
                    fontSize: 14,
                    color: liqDanger ? C.red : C.textBright,
                    fontWeight: 600,
                  }}>
                    {liqDanger ? "⚠ " : ""}
                    Price is {liqDistancePct.toFixed(1)}% away from the nearest liquidation price
                    {liqDanger ? " — position at risk" : ""}
                  </div>
                )}
                {wm.liquidationLower === 0 && wm.liquidationUpper === 0 && (
                  <div style={{ padding: "14px 24px", borderTop: `1px solid ${C.border}`, fontSize: 13, color: C.text, opacity: 0.6 }}>
                    {wm.protocolName} reports no liquidation price for this position.
                  </div>
                )}
              </div>

              {/* Pending yield + non-normal state */}
              <div style={{ marginTop: 18, display: "flex", gap: 28, flexWrap: "wrap", fontSize: 14 }}>
                <span style={{ color: C.text }}>
                  Uncollected yield:{" "}
                  <span style={{ color: C.green, fontWeight: 600 }}>
                    {wm.pendingYieldUSD != null ? fmt$(wm.pendingYieldUSD) : "—"}
                  </span>
                </span>
                {wm.state && wm.state.toLowerCase() !== "open" && wm.state.toLowerCase() !== "normal" && (
                  <span style={{ color: C.amber, fontWeight: 600 }}>State: {wm.state}</span>
                )}
              </div>

              <p style={{ marginTop: 18, fontSize: 12.5, color: C.text, opacity: 0.55, lineHeight: 1.55 }}>
                Figures are reported by {wm.protocolName} and verified on-chain (the position account&apos;s
                owner and authority). Per-position transaction history is not yet available for
                wrapper-held positions — the LP position lives in {wm.protocolName}&apos;s vault rather
                than your wallet.
              </p>
            </div>
          </Section>
        )}

        {/* ── CURRENT LIQUIDITY ────────────────────────────────────────── */}
        {hasAmounts && (
          <Section icon="[◎]" title="Current Liquidity" sub="Token balances actively deposited in the pool">
            <div className="pd-tokens" style={{
              margin: "0 40px",
              display: "grid", gridTemplateColumns: "1fr 1fr",
              border: `1px solid ${C.border}`,
            }}>
              {[
                { sym: t0, amount: pos.amount0, price: pos.price0, label: "Token A" },
                { sym: t1, amount: pos.amount1, price: pos.price1, label: "Token B" },
              ].map(({ sym, amount, price, label }, i, arr) => {
                const total = (pos.amount0 ?? 0) * (pos.price0 ?? 0) + (pos.amount1 ?? 0) * (pos.price1 ?? 0);
                const myUsd = (amount ?? 0) * (price ?? 0);
                const pct = total > 0 ? ((myUsd / total) * 100).toFixed(1) : "—";
                return (
                  <div key={sym} style={{
                    padding: "22px 26px",
                    borderRight: i === arr.length - 1 ? "none" : `1px solid ${C.border}`,
                  }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                      <span style={{ fontSize: 14, color: C.cyan, fontWeight: 700, letterSpacing: "0.08em" }}>{sym}</span>
                      <span style={{
                        fontSize: 11, color: C.text, letterSpacing: "0.1em",
                        padding: "2px 8px", border: `1px solid ${C.borderHi}`, textTransform: "uppercase",
                      }}>
                        {label} · {pct}%
                      </span>
                    </div>
                    <div style={{ fontSize: 30, fontWeight: 700, color: C.textWhite, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" }}>
                      {amount != null ? amount.toLocaleString("en-US", { maximumFractionDigits: 6 }) : "—"}
                    </div>
                    {amount != null && price && (
                      <div style={{ fontSize: 14, color: C.text, marginTop: 4, opacity: 0.7 }}>
                        {fmt$(myUsd)} · @ {fmtPrice(price)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {/* Total row */}
            <div style={{
              margin: "0 40px",
              padding: "14px 26px", borderTop: `1px solid ${C.border}`,
              display: "flex", alignItems: "center", justifyContent: "space-between",
              background: C.bg1,
            }}>
              <span style={{ fontSize: 14, color: C.text, letterSpacing: "0.06em" }}>
                Combined Liquidity Position
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                {(() => {
                  const total = (pos.amount0 ?? 0) * (pos.price0 ?? 0) + (pos.amount1 ?? 0) * (pos.price1 ?? 0);
                  if (total <= 0) return null;
                  const pct0 = ((pos.amount0 ?? 0) * (pos.price0 ?? 0) / total * 100).toFixed(1);
                  const pct1 = ((pos.amount1 ?? 0) * (pos.price1 ?? 0) / total * 100).toFixed(1);
                  return (
                    <span style={{ fontSize: 12, color: C.text, letterSpacing: "0.1em", textTransform: "uppercase", opacity: 0.6 }}>
                      {pct0} / {pct1} split
                    </span>
                  );
                })()}
                <span style={{
                  fontSize: 17, fontWeight: 700, color: C.green,
                  textShadow: "0 0 12px color-mix(in srgb, var(--accent) 20%, transparent)",
                  fontVariantNumeric: "tabular-nums",
                }}>
                  {fmt$(pos.value)}
                </span>
              </div>
            </div>
            <div style={{ height: 24 }} />
          </Section>
        )}

        {/* ── UNCOLLECTED FEES + REWARD EMISSIONS (invariant (k)) ───────── */}
        {(hasFees || pendingRewards.length > 0) && (
          <Section
            icon="[$]"
            title={pendingRewards.length > 0 ? "Uncollected Fees & Rewards" : "Uncollected Fees"}
            sub={pendingRewards.length > 0
              ? "Trading fees + reward emissions earned but not yet claimed on-chain"
              : "Trading fees earned but not yet claimed on-chain"}
            right={totalUncollectedUSD > 0 && manageUrl ? (
              <a href={manageUrl} target="_blank" rel="noopener noreferrer"
                className="btn-primary"
                style={{
                  fontFamily: FONT, fontSize: 14, fontWeight: 600,
                  letterSpacing: "0.1em", textTransform: "uppercase",
                  padding: "10px 18px", marginRight: 40, marginTop: 0,
                  border: `1px solid ${C.greenDim}`, background: C.greenFaint,
                  color: C.green, textDecoration: "none",
                  display: "inline-flex", alignItems: "center", gap: 8,
                  cursor: "pointer", transition: "all 0.15s",
                }}>
                ↗ Claim All
              </a>
            ) : null}
          >
            <div className="pd-tokens" style={{
              margin: "0 40px",
              display: "grid", gridTemplateColumns: "1fr 1fr",
              border: `1px solid ${C.border}`,
            }}>
              {[
                { sym: t0, fee: pos.fees0, price: pos.price0 },
                { sym: t1, fee: pos.fees1, price: pos.price1 },
              ].map(({ sym, fee, price }, i, arr) => {
                const usd0 = (pos.fees0 ?? 0) * (pos.price0 ?? 0);
                const usd1 = (pos.fees1 ?? 0) * (pos.price1 ?? 0);
                const totalFee = usd0 + usd1;
                const myUsd = (fee ?? 0) * (price ?? 0);
                const pct = totalFee > 0 ? ((myUsd / totalFee) * 100).toFixed(1) : "—";
                return (
                  <div key={sym} style={{
                    padding: "22px 26px",
                    borderRight: i === arr.length - 1 ? "none" : `1px solid ${C.border}`,
                  }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                      <span style={{ fontSize: 14, color: C.cyan, fontWeight: 700, letterSpacing: "0.08em" }}>{sym}</span>
                      <span style={{
                        fontSize: 11, color: C.text, letterSpacing: "0.1em",
                        padding: "2px 8px", border: `1px solid ${C.borderHi}`, textTransform: "uppercase",
                      }}>
                        {pct}%
                      </span>
                    </div>
                    <div style={{ fontSize: 30, fontWeight: 700, color: C.textWhite, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" }}>
                      {fee != null ? fee.toLocaleString("en-US", { maximumFractionDigits: 6 }) : "—"}
                    </div>
                    {fee != null && price && (
                      <div style={{ fontSize: 14, color: C.text, marginTop: 4, opacity: 0.7 }}>
                        {fmt$(myUsd)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {/* Pending reward emissions (Sprint POSITION-DETAIL) — one cell per
                reward token, read from on-chain rewarder state, valued at spot.
                Absent entirely when the pool has no accrued rewards. */}
            {pendingRewards.length > 0 && (
              <div className="pd-tokens" style={{
                margin: "0 40px",
                display: "grid", gridTemplateColumns: `repeat(${Math.min(pendingRewards.length, 3)}, 1fr)`,
                border: `1px solid ${C.border}`, borderTop: "none",
              }}>
                {pendingRewards.map((r, i) => (
                  <div key={`${r.coinType}-${i}`} style={{
                    padding: "22px 26px",
                    borderRight: i === pendingRewards.length - 1 ? "none" : `1px solid ${C.border}`,
                  }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                      <span style={{ fontSize: 14, color: C.cyan, fontWeight: 700, letterSpacing: "0.08em" }}>{r.symbol}</span>
                      <span style={{
                        fontSize: 11, color: C.text, letterSpacing: "0.1em",
                        padding: "2px 8px", border: `1px solid ${C.borderHi}`, textTransform: "uppercase",
                      }}>
                        reward
                      </span>
                    </div>
                    <div style={{ fontSize: 30, fontWeight: 700, color: C.textWhite, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" }}>
                      {r.amount.toLocaleString("en-US", { maximumFractionDigits: 6 })}
                    </div>
                    <div style={{ fontSize: 14, color: C.text, marginTop: 4, opacity: 0.7 }}>
                      {fmt$(r.usd)}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div style={{
              margin: "0 40px",
              padding: "14px 26px", borderTop: `1px solid ${C.border}`,
              display: "flex", alignItems: "center", justifyContent: "space-between",
              background: C.bg1,
            }}>
              <span style={{ fontSize: 14, color: C.text, letterSpacing: "0.06em" }}>Total Uncollected</span>
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <span style={{ fontSize: 12, color: C.text, letterSpacing: "0.1em", textTransform: "uppercase", opacity: 0.6 }}>
                  {pendingRewards.length > 0 ? "fees + rewards · ready to collect" : "ready to collect"}
                </span>
                <span style={{
                  fontSize: 17, fontWeight: 700, color: C.green,
                  textShadow: "0 0 12px color-mix(in srgb, var(--accent) 20%, transparent)",
                  fontVariantNumeric: "tabular-nums",
                }}>
                  {fmt$(totalUncollectedUSD)}
                </span>
              </div>
            </div>
            <div style={{ height: 24 }} />
          </Section>
        )}

        {/* ── PERFORMANCE METRICS ──────────────────────────────────────── */}
        <Section icon="[△]" title="Performance Metrics" sub="Calculated from real on-chain fee claims">
          <div style={{ padding: "0 40px" }}>
            <div className="pd-perf-top" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", border: `1px solid ${C.border}` }}>
              {[
                { label: "Total Claimed", val: activityLoading ? "…" : fmt$(claimedUSD), color: C.green, sub: activityLoading ? "loading…" : isActivityProtocol ? `${feeClaims.length} claim${feeClaims.length !== 1 ? "s" : ""} on-chain` : "no data" },
                { label: "Uncollected", val: fmt$(totalUncollectedUSD), color: C.green, sub: pendingRewards.length > 0 ? "fees + rewards pending" : "pending" },
                { label: "Total Lifetime", val: fmt$(lifetimeUSD), color: C.textWhite, sub: "claimed + pending" },
                {
                  // Actual APR cell — label now carries the D/W/M/Y
                  // timeframe toggle. Inline style matches the analytics
                  // page convention (border shorthand on active, none on
                  // inactive — no CSS classes, no specificity conflicts).
                  label: (
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                      <span>Actual APR</span>
                      <div className="dash-perf-toggle" style={{ display: "flex" }}>
                        {(["D", "W", "M", "Y"] as const).map((v) => {
                          const active = aprView === v;
                          return (
                            <button
                              key={v}
                              type="button"
                              onClick={() => setAprView(v)}
                              style={{
                                fontFamily: FONT,
                                fontSize: 10,
                                padding: "2px 7px",
                                cursor: "pointer",
                                letterSpacing: "0.1em",
                                textTransform: "uppercase",
                                border: active ? "1px solid var(--accent)" : "none",
                                background: "transparent",
                                color: active ? "var(--accent)" : C.text,
                                marginLeft: 2,
                              }}
                              aria-pressed={active}
                              aria-label={`Show ${v === "D" ? "daily" : v === "W" ? "weekly" : v === "M" ? "monthly" : "yearly"} rate`}
                            >
                              {v}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ),
                  val: activityLoading ? "…" : actualAPR != null ? `~${(actualAPR / APR_DIVISOR[aprView]).toFixed(aprView === "D" ? 3 : 1)}%` : "—",
                  color: C.green,
                  sub: projFromUncollected ? "from uncollected (early estimate)" : "from real claims",
                },
                { label: "Estimated APR", val: hasApr ? `~${(pos.apy / APR_DIVISOR[aprView]).toFixed(aprView === "D" ? 3 : 1)}%` : derivedApr != null ? `~${(derivedApr / APR_DIVISOR[aprView]).toFixed(aprView === "D" ? 3 : 1)}%` : "—", color: C.cyan, sub: hasApr ? "pool APY" : derivedApr != null ? "derived from earnings" : "too early to estimate" },
                { label: "Position Age", val: daysLabel, color: C.textWhite, sub: openedDate ? `since ${openedDate}` : "tracking age" },
              ].map((c, i) => (
                // Key is the index because c.label is now ReactNode for the
                // Actual APR cell (carries the D/W/M/Y toggle). Stable
                // because the array order never changes.
                <div key={i} style={{
                  padding: cellPadding,
                  borderRight: (i + 1) % 3 === 0 ? "none" : `1px solid ${C.border}`,
                  borderBottom: i < 3 ? `1px solid ${C.border}` : "none",
                }}>
                  <div style={labelStyle}>{c.label}</div>
                  <div style={{
                    fontSize: 28, fontWeight: 700, letterSpacing: "-0.02em",
                    color: c.color,
                    textShadow: c.color === C.green ? "0 0 14px color-mix(in srgb, var(--accent) 20%, transparent)" : "none",
                    fontVariantNumeric: "tabular-nums",
                  }}>
                    {c.val}
                  </div>
                  <div style={subStyle}>{c.sub}</div>
                </div>
              ))}
            </div>
            {/* Bottom 2-cell row */}
            <div className="pd-perf-bottom" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", border: `1px solid ${C.border}`, borderTop: "none" }}>
              <div style={{ padding: cellPadding, borderRight: `1px solid ${C.border}` }}>
                {/* Label + value + suffix all driven by aprView. The
                    underlying actualDailyIncome is a per-day rate, so the
                    multiplier scales it up to the selected period. */}
                <div style={labelStyle}>{INCOME_LABEL[aprView]}</div>
                <div style={{
                  fontSize: 28, fontWeight: 700, letterSpacing: "-0.02em", color: C.green,
                  textShadow: "0 0 14px color-mix(in srgb, var(--accent) 20%, transparent)", fontVariantNumeric: "tabular-nums",
                }}>
                  {activityLoading ? "…" : actualDailyIncome != null
                    ? <>{fmt$(actualDailyIncome * INCOME_MULTIPLIER[aprView])}<span style={{ fontSize: 16, color: C.text, fontWeight: 400, marginLeft: 6, letterSpacing: 0 }}>{INCOME_SUFFIX[aprView]}</span></>
                    : "—"}
                </div>
                <div style={subStyle}>{projFromUncollected ? "from uncollected (early estimate)" : "trailing 30d average"}</div>
              </div>
              <div style={{ padding: cellPadding, position: "relative" }}>
                <div style={{ ...labelStyle, display: "flex", alignItems: "center" }}>
                  Fee Income Rate
                  <InfoTooltip
                    text="Fee Income Rate is the annualised return from trading fees only, excluding price appreciation or impermanent loss. Calculated as: (Total Fees Collected / Average Position Value) × (365 / Days Active) × 100. This shows how efficiently your liquidity is earning fees."
                  />
                </div>
                <div style={{
                  fontSize: 28, fontWeight: 700, letterSpacing: "-0.02em", color: C.textWhite,
                  fontVariantNumeric: "tabular-nums",
                }}>
                  {/* feeIncomePct is the 30-day-derived percentage stored
                      at the M base. Scale per the period selected above. */}
                  {(feeIncomePct * FEE_RATE_FROM_30D[aprView]).toFixed(3)}%
                </div>
                <div style={subStyle}>of position value {FEE_PERIOD_LABEL[aprView]}</div>
              </div>
            </div>
            <div style={{ height: 24 }} />
          </div>
        </Section>

        {/* ── FEE ACCUMULATION CHART ───────────────────────────────────── */}
        {isActivityProtocol && (
          <Section icon="[⏱]" title="Fee Accumulation" sub="Cumulative fees collected over position lifetime">
            <div style={{ padding: "0 40px 28px" }}>
              <div style={{ border: `1px solid ${C.border}`, padding: "20px 24px", background: C.bg1, position: "relative", overflow: "hidden" }}>
                {/* Top scan sweep */}
                <div aria-hidden style={{
                  position: "absolute", top: 0, left: 0, width: 80, height: 1,
                  background: `linear-gradient(90deg, transparent, ${C.green}, transparent)`,
                  animation: "_scan 3s ease-in-out infinite",
                }} />
                {/* Chart meta */}
                <div style={{ display: "flex", alignItems: "center", marginBottom: 14, gap: 0 }}>
                  <div style={{ marginLeft: "auto", display: "flex", gap: 24 }}>
                    {(() => {
                      const peak = feeClaims.length > 0 ? Math.max(...feeClaims.map(e => e.usdAtTime ?? 0)) : 0;
                      const avgClaim = feeClaims.length > 0 ? claimedUSD / feeClaims.length : 0;
                      return [
                        { lbl: "Avg / Claim", val: fmt$(avgClaim), color: C.textBright },
                        { lbl: "Peak Claim", val: fmt$(peak), color: C.green },
                        { lbl: "Total", val: fmt$(lifetimeUSD), color: C.green },
                      ].map((m) => (
                        <div key={m.lbl} style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                          <span style={{ color: C.text, opacity: 0.5, letterSpacing: "0.12em", textTransform: "uppercase", fontSize: 11 }}>{m.lbl}</span>
                          <span style={{ fontWeight: 700, color: m.color, fontSize: 15, fontVariantNumeric: "tabular-nums" }}>{m.val}</span>
                        </div>
                      ));
                    })()}
                  </div>
                </div>
                {/* Chart */}
                {(activityLoading || activityPending) ? (
                  <div style={{ height: 200, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, color: C.text, fontSize: 14, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                    <div style={{ width: 14, height: 14, border: `2px solid ${C.green}`, borderTopColor: "transparent", animation: "_spin 1s linear infinite" }} />
                    Loading…
                  </div>
                ) : !feeChartData || feeChartData.noClaimsYet || feeChartData.chartData.length < 2 ? (
                  <div style={{ height: 200, display: "flex", alignItems: "center", justifyContent: "center", color: C.text, fontSize: 15 }}>
                    No fee claims yet
                  </div>
                ) : (
                  <div style={{ width: "100%", height: 200 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={feeChartData.chartData}>
                        <defs>
                          <linearGradient id="feeAccumGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={C.green} stopOpacity={0.28} />
                            <stop offset="60%" stopColor={C.green} stopOpacity={0.06} />
                            <stop offset="100%" stopColor={C.green} stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="4 8" stroke="var(--surface-hover)" vertical={false} />
                        <XAxis dataKey="label" tick={{ fill: C.text, fontSize: 12, fontFamily: FONT }} axisLine={false} tickLine={false} />
                        <YAxis
                          tick={{ fill: C.text, fontSize: 12, fontFamily: FONT }}
                          tickFormatter={(v) => `$${Math.round(v).toLocaleString()}`}
                          axisLine={false} tickLine={false} width={50}
                        />
                        <Tooltip
                          contentStyle={{ background: C.bg1, border: `1px solid ${C.borderHi}`, padding: "8px 12px", color: C.textBright, fontSize: 14, fontFamily: FONT }}
                          itemStyle={{ color: C.textBright }}
                          labelStyle={{ color: C.text }}
                          formatter={(v: number | undefined) => [`$${(v ?? 0).toFixed(2)}`, "Cumulative Fees"]}
                        />
                        <Area type="monotone" dataKey="value" stroke={C.green} strokeWidth={1.6} fill="url(#feeAccumGrad)" dot={{ r: 3, fill: C.bg, stroke: C.green, strokeWidth: 1.5 }} activeDot={{ r: 5, fill: C.green }} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )}
                {feeChartData && !feeChartData.noClaimsYet && feeChartData.chartData.length >= 2 && (
                  <div style={{ textAlign: "center", fontSize: 12, color: C.text, opacity: 0.5, marginTop: 12, letterSpacing: "0.08em" }}>
                    ● markers indicate fee claim events · {feeChartData.chartData.length - 1} claims since {new Date(feeChartData.openTs).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
                  </div>
                )}
              </div>
            </div>
          </Section>
        )}

        {/* ── FEE CLAIMS HISTORY ───────────────────────────────────────── */}
        <Section icon="[⤓]" title="Fee Claims History" sub="On-chain claim transactions for this position">
          <div style={{ padding: "0 40px 24px" }}>
            {(activityLoading || activityPending) ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10, color: C.text, fontSize: 15, padding: "12px 0" }}>
                <div style={{ width: 14, height: 14, border: `2px solid ${C.green}`, borderTopColor: "transparent", animation: "_spin 1s linear infinite", flexShrink: 0 }} />
                Scanning blockchain for fee history…
              </div>
            ) : !isActivityProtocol ? (
              <p style={{ fontSize: 15, color: C.text, opacity: 0.55 }}>
                Activity data not available for {pos.protocol} — on-chain fee history scanning is not yet supported.
              </p>
            ) : activityError ? (
              <p style={{ fontSize: 15, color: C.text, opacity: 0.55 }}>
                Could not load fee claim data. The blockchain scan may have timed out — try refreshing.
              </p>
            ) : feeClaims.length === 0 ? (
              <p style={{ fontSize: 15, color: C.text, opacity: 0.55 }}>
                No fee claims detected yet. Claims will appear here after you collect fees on-chain.
              </p>
            ) : (
              <div style={{ border: `1px solid ${C.border}` }}>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: FONT }}>
                    <thead>
                      <tr style={{ background: C.bg1 }}>
                        <th style={{
                          padding: "12px 20px", fontSize: 12, fontWeight: 400,
                          color: C.text, letterSpacing: "0.18em", textTransform: "uppercase",
                          borderBottom: `1px solid ${C.border}`, opacity: 0.6, textAlign: "left",
                        }}>Date (UTC)</th>
                        <th style={{
                          padding: "12px 20px", fontSize: 12, fontWeight: 400,
                          color: C.text, letterSpacing: "0.18em", textTransform: "uppercase",
                          borderBottom: `1px solid ${C.border}`, opacity: 0.6, textAlign: "right",
                        }}>{t0}</th>
                        <th style={{
                          padding: "12px 20px", fontSize: 12, fontWeight: 400,
                          color: C.text, letterSpacing: "0.18em", textTransform: "uppercase",
                          borderBottom: `1px solid ${C.border}`, opacity: 0.6, textAlign: "right",
                        }}>{t1}</th>
                        <th style={{
                          padding: "12px 20px", fontSize: 12, fontWeight: 400,
                          color: C.text, letterSpacing: "0.18em", textTransform: "uppercase",
                          borderBottom: `1px solid ${C.border}`, opacity: 0.6, textAlign: "right",
                        }}>Total USD</th>
                        <th className="pd-tx-col" style={{
                          padding: "12px 20px", fontSize: 12, fontWeight: 400,
                          color: C.text, letterSpacing: "0.18em", textTransform: "uppercase",
                          borderBottom: `1px solid ${C.border}`, opacity: 0.6, textAlign: "right",
                        }}>Tx</th>
                      </tr>
                    </thead>
                    <tbody>
                      {feeClaims.map((ev, i) => {
                        const usd = ev.usdAtTime ?? (ev.amount0 * (pos.price0 ?? 0) + ev.amount1 * (pos.price1 ?? 0));
                        return (
                          <tr key={i} className="pos-row" style={{ borderBottom: i === feeClaims.length - 1 ? "none" : `1px solid ${C.border}` }}>
                            <td style={{ padding: "11px 20px", fontSize: 15, color: C.textMid, whiteSpace: "nowrap" as const }}>{fmtDate(ev.timestamp)}</td>
                            <td style={{ padding: "11px 20px", fontSize: 15, color: C.textMid, fontVariantNumeric: "tabular-nums", textAlign: "right" }}>
                              {ev.type === 'reward_claim'
                                /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
                                ? `${fmtAmt(ev.amount0)} ${(ev as any).rewardSymbol ?? ''}`
                                : fmtAmt(ev.amount0)}
                            </td>
                            <td style={{ padding: "11px 20px", fontSize: 15, color: C.textMid, fontVariantNumeric: "tabular-nums", textAlign: "right" }}>
                              {ev.type === 'reward_claim' ? '—' : fmtAmt(ev.amount1)}
                            </td>
                            <td style={{ padding: "11px 20px", fontSize: 15, color: C.green, fontWeight: 600, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                              {fmt$(usd)}
                            </td>
                            <td className="pd-tx-col" style={{ padding: "11px 20px", textAlign: "right" }}>
                              <a className="tx-link" href={txUrl(ev.txHash)} target="_blank" rel="noopener noreferrer"
                                style={{ color: C.cyan, fontSize: 14, textDecoration: "none", transition: "opacity 0.15s" }}>
                                {shortHash(ev.txHash)} ↗
                              </a>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div style={{
                  padding: "12px 20px", borderTop: `1px solid ${C.border}`,
                  display: "flex", justifyContent: "space-between", alignItems: "center", background: C.bg1,
                }}>
                  <span style={{ fontSize: 14, color: C.text, letterSpacing: "0.04em" }}>{feeClaims.length} collection{feeClaims.length !== 1 ? "s" : ""}</span>
                  <span style={{ fontSize: 16, color: C.green, fontWeight: 700 }}>
                    <span style={{ color: C.text, fontWeight: 400, marginRight: 6, opacity: 0.6 }}>Total Claimed:</span>
                    {fmt$(claimedUSD)}
                  </span>
                </div>
              </div>
            )}
          </div>
        </Section>

        {/* ── CONCENTRATED LIQUIDITY RANGE ─────────────────────────────── */}
        {hasRange && (
          <Section
            icon="[◉]"
            title="Concentrated Liquidity Range"
            sub="Active price band — earning fees only when current price stays inside"
            right={
              <span style={{
                marginRight: 40,
                fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase",
                padding: "4px 12px", fontWeight: 600,
                display: "inline-flex", alignItems: "center", gap: 6,
                border: `1px solid ${isClosed ? C.borderHi : posStatus === "In Range" ? C.greenDim : C.amber}`,
                background: isClosed ? C.bg2 : posStatus === "In Range" ? C.greenFaint : "color-mix(in srgb, var(--warn) 6%, transparent)",
                color: isClosed ? C.text : posStatus === "In Range" ? C.green : C.amber,
              }}>
                {!isClosed && posStatus === "In Range" && (
                  <span style={{ width: 6, height: 6, background: C.green, animation: "_pulse 2s infinite" }} />
                )}
                {isClosed ? "Position Closed" : posStatus === "In Range" ? "Position Active" : "Out of Range"}
              </span>
            }
          >
            <div style={{ padding: "0 40px 24px" }}>
              <div style={{
                border: `1px solid ${C.border}`, padding: "24px 28px",
                background: C.bg1, position: "relative", overflow: "hidden",
              }}>
                <div aria-hidden style={{
                  position: "absolute", top: 0, left: 0, width: 80, height: 1,
                  background: `linear-gradient(90deg, transparent, ${C.green}, transparent)`,
                  animation: "_scan 3s ease-in-out infinite",
                }} />
                {/* Price labels */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", marginBottom: 14 }}>
                  <div>
                    <div style={{ fontSize: 12, color: C.text, letterSpacing: "0.16em", textTransform: "uppercase", opacity: 0.6, marginBottom: 6 }}>Min Price</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: C.textWhite, letterSpacing: "-0.01em" }}>
                      {minPriceUSD != null ? fmtPrice(minPriceUSD) : "—"}
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                    <div style={{ fontSize: 12, color: C.text, letterSpacing: "0.16em", textTransform: "uppercase", opacity: 0.6, marginBottom: 6 }}>Current Price</div>
                    <div style={{
                      fontSize: 22, fontWeight: 700, letterSpacing: "-0.01em",
                      color: isClosed ? C.text : posStatus === "In Range" ? C.green : C.amber,
                      textShadow: !isClosed && posStatus === "In Range" ? "0 0 12px color-mix(in srgb, var(--accent) 30%, transparent)" : "none",
                    }}>
                      {curPriceUSD != null ? fmtPrice(curPriceUSD) : "—"}
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                    <div style={{ fontSize: 12, color: C.text, letterSpacing: "0.16em", textTransform: "uppercase", opacity: 0.6, marginBottom: 6 }}>Max Price</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: C.textWhite, letterSpacing: "-0.01em" }}>
                      {maxPriceUSD != null ? fmtPrice(maxPriceUSD) : "—"}
                    </div>
                  </div>
                </div>
                {/* Track */}
                <div style={{ position: "relative", height: 36, marginTop: 14 }}>
                  <div style={{
                    position: "absolute", left: 0, right: 0, top: 14, height: 8,
                    background: `repeating-linear-gradient(90deg, ${C.border} 0, ${C.border} 1px, transparent 1px, transparent 4px)`,
                    borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}`,
                  }} />
                  <div style={{
                    position: "absolute", top: 14, left: 0, height: 8,
                    width: `${rangeBarPct}%`,
                    background: `linear-gradient(90deg, ${C.greenDim}, ${C.green})`,
                    boxShadow: "0 0 8px color-mix(in srgb, var(--accent) 40%, transparent)",
                    transition: "width 1.2s cubic-bezier(0.22,1,0.36,1)",
                  }} />
                  {curPriceUSD != null && !isClosed && (
                    isOutOfRangeBelow ? (
                      // Out of range below — no green fill; amber pulse at the
                      // LEFT tip of the track signals price dropped under min.
                      <div style={{
                        position: "absolute", top: 8, left: 0, width: 6, height: 20,
                        background: C.amber,
                        boxShadow: "0 0 12px color-mix(in srgb, var(--warn) 85%, transparent)",
                        animation: "_pulse 1.4s infinite",
                        zIndex: 3,
                      }} />
                    ) : isOutOfRangeAbove ? (
                      // Out of range above — green fill stretched to 100%; amber
                      // pulse at the RIGHT tip signals price exceeded max.
                      <div style={{
                        position: "absolute", top: 8, right: 0, width: 6, height: 20,
                        background: C.amber,
                        boxShadow: "0 0 12px color-mix(in srgb, var(--warn) 85%, transparent)",
                        animation: "_pulse 1.4s infinite",
                        zIndex: 3,
                      }} />
                    ) : (
                      // In range — original behaviour: 2px green tick at the
                      // proportional bar position marking the current price.
                      <div style={{
                        position: "absolute", top: 8, width: 2, height: 20,
                        left: `calc(${rangeBarPct}% - 1px)`,
                        background: C.green, boxShadow: "0 0 8px color-mix(in srgb, var(--accent) 80%, transparent)", zIndex: 3,
                      }} />
                    )
                  )}
                </div>
                {/* Ticks */}
                {minPriceUSD != null && maxPriceUSD != null && (
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.text, letterSpacing: "0.1em", opacity: 0.4, marginTop: 18 }}>
                    {[0, 0.25, 0.5, 0.75, 1].map((t, i) => (
                      <span key={i}>{fmtPrice(minPriceUSD + (maxPriceUSD - minPriceUSD) * t)}</span>
                    ))}
                  </div>
                )}
                {/* Stats row */}
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 18, paddingTop: 14, borderTop: `1px solid ${C.border}`, flexWrap: "wrap", gap: 16 }}>
                  <div>
                    <div style={{ fontSize: 11, color: C.text, letterSpacing: "0.16em", textTransform: "uppercase", opacity: 0.6, marginBottom: 3 }}>Range Width</div>
                    <div style={{ fontSize: 15, color: C.textBright, fontWeight: 600 }}>{rangeWidthPct ?? "—"}%</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: C.text, letterSpacing: "0.16em", textTransform: "uppercase", opacity: 0.6, marginBottom: 3 }}>Distance to Lower</div>
                    <div style={{ fontSize: 15, color: C.textBright, fontWeight: 600 }}>{distLower != null ? `${distLower}%` : "—"}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: C.text, letterSpacing: "0.16em", textTransform: "uppercase", opacity: 0.6, marginBottom: 3 }}>Distance to Upper</div>
                    <div style={{ fontSize: 15, color: C.textBright, fontWeight: 600 }}>{distUpper != null ? `+${distUpper}%` : "—"}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 11, color: C.text, letterSpacing: "0.16em", textTransform: "uppercase", opacity: 0.6, marginBottom: 3 }}>Position Age</div>
                    <div style={{ fontSize: 15, color: C.green, fontWeight: 600 }}>{daysLabel}</div>
                  </div>
                </div>
              </div>
            </div>
          </Section>
        )}

        {/* ── YIELD & APR PROJECTIONS ──────────────────────────────────── */}
        <Section icon="[%]" title="Yield & APR Projections" sub={!hasApr && projection.actualApr != null ? "Early estimate from uncollected fees — refines as the position accrues fees and claims" : "Forward-looking estimates based on trailing pool fee rate"}>
          <div style={{ padding: "0 40px 24px" }}>
            <div className="pd-yield-grid" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", border: `1px solid ${C.border}` }}>
              {([
                { label: "Daily",   div: 365,  amt: dailyUSD,   proj: projection.daily,   unit: "day" },
                { label: "Weekly",  div: 52,   amt: weeklyUSD,  proj: projection.weekly,  unit: "week" },
                { label: "Monthly", div: 12,   amt: monthlyUSD, proj: projection.monthly, unit: "month" },
                { label: "Yearly",  div: 1,    amt: yearlyUSD,  proj: projection.yearly,  unit: "year" },
              ] as const).map(({ label, div, amt, proj, unit }, i, arr) => (
                <div key={label} style={{
                  padding: "22px 24px",
                  borderRight: i === arr.length - 1 ? "none" : `1px solid ${C.border}`,
                }}>
                  <div style={{ ...labelStyle, marginBottom: 10 }}>{label}</div>
                  {hasApr ? (
                    <>
                      <div style={{
                        fontSize: 30, fontWeight: 700, color: C.green,
                        textShadow: "0 0 14px color-mix(in srgb, var(--accent) 20%, transparent)", letterSpacing: "-0.02em",
                        fontVariantNumeric: "tabular-nums",
                      }}>
                        +{(pos.apy / div).toFixed(div >= 52 ? 3 : 2)}%
                      </div>
                      <div style={subStyle}>{amt != null ? fmt$(amt) : "—"} / {unit}</div>
                    </>
                  ) : (projection.actualApr != null && proj != null) ? (
                    // Sprint 1.8b: no pool APY → project from uncollected fees (early
                    // estimate). Section sub above labels the source honestly.
                    <>
                      <div style={{
                        fontSize: 30, fontWeight: 700, color: C.green,
                        textShadow: "0 0 14px color-mix(in srgb, var(--accent) 20%, transparent)", letterSpacing: "-0.02em",
                        fontVariantNumeric: "tabular-nums",
                      }}>
                        +{(projection.actualApr / div).toFixed(div >= 52 ? 3 : 2)}%
                      </div>
                      <div style={subStyle}>{fmt$(proj)} / {unit}</div>
                    </>
                  ) : (
                    <div style={{ fontSize: 20, color: C.text, opacity: 0.5, fontStyle: "italic" }}>N/A</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </Section>

        {/* ── ON-CHAIN P&L + IL ────────────────────────────────────────── */}
        {isActivityProtocol && (
          <Section icon="[Σ]" title="On-Chain P&L & Impermanent Loss" sub="Performance versus a simple hold-the-tokens strategy">
            <div style={{ padding: "0 40px 24px" }}>
              {(activityLoading || activityPending) ? (
                <p style={{ fontSize: 15, color: C.text, opacity: 0.55 }}>
                  Reconstructing position from on-chain history…
                </p>
              ) : !activity ? (
                <p style={{ fontSize: 15, color: C.text, opacity: 0.55 }}>
                  Entry data unavailable — P&amp;L cannot be computed.
                </p>
              ) : !pnl ? (
                <p style={{ fontSize: 15, color: C.text, opacity: 0.55 }}>
                  Entry data unavailable — no on-chain deposit event found for this position. P&amp;L cannot be computed.
                </p>
              ) : (
                <div style={{ border: `1px solid ${C.border}` }}>
                  {/* 5-stat grid */}
                  <div className="pd-pnl-stats" style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", borderBottom: `1px solid ${C.border}` }}>
                    {[
                      { label: "Initial Value", val: fmt$(pnl.initialValue), color: C.textWhite, sub: "at deposit time" },
                      { label: pnl.isClosed ? "Closing Value" : "Current Value", val: fmt$(pnl.isClosed ? pnl.closingValue : pnl.currentValue), color: C.textWhite, sub: pnl.isClosed ? "at close time" : "live mark" },
                      { label: "Fees Collected", val: fmt$(pnl.feesCollected), color: C.green, sub: "claimed on-chain" },
                      { label: "Fees Unclaimed", val: fmt$(pnl.feesUnclaimed), color: C.green, sub: "ready to claim" },
                      {
                        label: "Impermanent Loss",
                        val: `${ilNegative ? "−" : "+"}${fmt$(Math.abs(pnl.ilUSD))}`,
                        color: ilNegative ? C.red : C.green,
                        sub: `${pnl.ilPct.toFixed(2)}%`,
                        subColor: ilNegative ? C.red : C.green,
                      },
                    ].map((c, i, arr) => (
                      <div key={c.label} style={{
                        padding: "20px 22px",
                        borderRight: i === arr.length - 1 ? "none" : `1px solid ${C.border}`,
                      }}>
                        <div style={labelStyle}>{c.label}</div>
                        <div style={{
                          fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em",
                          color: c.color,
                          textShadow: c.color === C.green ? "0 0 14px color-mix(in srgb, var(--accent) 20%, transparent)" : "none",
                          fontVariantNumeric: "tabular-nums",
                        }}>
                          {c.val}
                        </div>
                        <div style={{ ...subStyle, color: c.subColor ?? C.text, opacity: c.subColor ? 1 : 0.6 }}>{c.sub}</div>
                      </div>
                    ))}
                  </div>
                  {/* Summary panel */}
                  <div className="pd-pnl-summary" style={{
                    background: "linear-gradient(135deg, color-mix(in srgb, var(--accent) 4%, transparent), color-mix(in srgb, var(--accent) 1%, transparent))",
                    padding: "24px 28px",
                    display: "grid", gridTemplateColumns: "2fr 1fr 1fr",
                    gap: 32,
                    borderTop: `1px solid ${C.greenDim}`,
                    position: "relative",
                  }}>
                    <div aria-hidden style={{
                      position: "absolute", top: 0, left: 0, right: 0, height: 1,
                      background: `linear-gradient(90deg, transparent, ${C.green} 50%, transparent)`,
                      opacity: 0.6,
                    }} />
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <div style={{ fontSize: 14, color: C.green, letterSpacing: "0.2em", textTransform: "uppercase", fontWeight: 600 }}>
                        Net P&amp;L
                      </div>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
                        <div style={{
                          fontSize: 36, fontWeight: 700,
                          color: pnlPositive ? C.green : C.red,
                          letterSpacing: "-0.03em",
                          textShadow: pnlPositive ? "0 0 20px color-mix(in srgb, var(--accent) 30%, transparent)" : "0 0 20px color-mix(in srgb, var(--neg) 30%, transparent)",
                          fontVariantNumeric: "tabular-nums",
                        }}>
                          {pnlPositive ? "+" : "−"}{fmt$(Math.abs(pnl.netPnlUSD))}
                        </div>
                        <div style={{
                          fontSize: 17, fontWeight: 600,
                          color: pnlPositive ? C.green : C.red,
                          opacity: 0.8,
                        }}>
                          {pnlPositive ? "+" : ""}{pnl.netPnlPct.toFixed(2)}%
                        </div>
                      </div>
                      <div className="pd-pnl-formula" style={{ fontSize: 14, color: C.text, opacity: 0.7, letterSpacing: "0.02em", lineHeight: 1.6 }}>
                        {pnl.isClosed
                          ? `(${fmt$(pnl.closingValue)} closing + ${fmt$(pnl.feesCollected)} fees) − ${fmt$(pnl.initialValue)} initial`
                          : `(${fmt$(pnl.currentValue)} current + ${fmt$(pnl.feesCollected)} fees + ${fmt$(pnl.feesUnclaimed)} unclaimed) − ${fmt$(pnl.initialValue)} initial`}
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end", paddingLeft: 32, borderLeft: `1px solid ${C.border}` }}>
                      <div style={{ fontSize: 12, color: C.text, letterSpacing: "0.18em", textTransform: "uppercase", opacity: 0.7 }}>HODL Value</div>
                      <div style={{ fontSize: 25, fontWeight: 700, color: C.textWhite, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" }}>
                        {fmt$(pnl.hodlValue)}
                      </div>
                      <div style={{ fontSize: 11, color: C.text, opacity: 0.6, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                        if you just held
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end", paddingLeft: 32, borderLeft: `1px solid ${C.border}` }}>
                      <div style={{ fontSize: 12, color: C.text, letterSpacing: "0.18em", textTransform: "uppercase", opacity: 0.7 }}>Fees vs IL</div>
                      <div style={{
                        fontSize: 25, fontWeight: 700, letterSpacing: "-0.02em",
                        color: pnl.feesOffsetIL ? C.cyan : C.red,
                      }}>
                        {pnl.feesOffsetIL ? "Offset ✓" : "Not offset ✗"}
                      </div>
                      <div style={{ fontSize: 11, color: C.text, opacity: 0.6, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                        {fmt$(totalFees)} fees vs {fmt$(Math.abs(pnl.ilUSD))} IL
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </Section>
        )}

        {/* ── POOL STATISTICS ─────────────────────────────────────────── */}
        <Section icon="[⚡]" title="Pool Statistics" sub={`Aggregate metrics for ${pos.pair} on ${pos.protocol}`}>
          <div style={{ padding: "0 40px 32px" }}>
            <div className="pd-pool-stats" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", border: `1px solid ${C.border}` }}>
              {([
                { label: "Pool TVL",   value: poolStats?.tvlUsd ?? null,    sub: "total value locked" },
                { label: "24H Volume", value: poolStats?.volumeUsd1d ?? null, sub: "trailing 24h" },
                { label: "24H Fees",   value: poolStats?.feesUsd1d ?? null,   sub: pos.feeTier != null ? `@ ${pos.feeTier}% fee tier` : "pool fees" },
              ] as const).map(({ label, value, sub }, i, arr) => (
                <div key={label} style={{
                  padding: "22px 24px",
                  borderRight: i === arr.length - 1 ? "none" : `1px solid ${C.border}`,
                }}>
                  <div style={labelStyle}>{label}</div>
                  {poolStatsLoading ? (
                    <div style={{ fontSize: 20, color: C.text, opacity: 0.4 }}>…</div>
                  ) : value != null ? (
                    <>
                      <div style={{ fontSize: 25, fontWeight: 700, color: C.textWhite, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" }}>
                        {fmtLarge(value)}
                      </div>
                      <div style={subStyle}>{sub}</div>
                    </>
                  ) : (
                    <div style={{ fontSize: 16, color: C.text, opacity: 0.5, fontStyle: "italic" }}>Data unavailable</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </Section>

        {/* ── PAGE FOOTER ─────────────────────────────────────────────── */}
        <div style={{
          padding: "24px 40px",
          display: "flex", justifyContent: "space-between", alignItems: "center",
          borderTop: `1px solid ${C.border}`, background: C.bg1, gap: 12, flexWrap: "wrap",
        }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ fontSize: 11, color: C.text, letterSpacing: "0.2em", textTransform: "uppercase", opacity: 0.5 }}>
              Position ID
            </div>
            <div style={{ fontSize: 14, color: C.textMid, fontFamily: FONT, letterSpacing: "0.02em", wordBreak: "break-all" }}>
              {pos.id}
            </div>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <Link href={backHref}
              className="btn-neutral"
              style={{
                fontFamily: FONT, fontSize: 14, fontWeight: 600,
                letterSpacing: "0.1em", textTransform: "uppercase",
                padding: "10px 18px",
                border: `1px solid ${C.borderHi}`, background: "transparent",
                color: C.textMid, textDecoration: "none",
                display: "flex", alignItems: "center", gap: 8,
                cursor: "pointer", transition: "all 0.15s",
              }}>
              ← Dashboard
            </Link>
            {manageUrl && (
              <a href={manageUrl} target="_blank" rel="noopener noreferrer"
                className="btn-primary"
                style={{
                  fontFamily: FONT, fontSize: 14, fontWeight: 600,
                  letterSpacing: "0.1em", textTransform: "uppercase",
                  padding: "10px 18px",
                  border: `1px solid ${C.greenDim}`, background: C.greenFaint,
                  color: C.green, textDecoration: "none",
                  display: "flex", alignItems: "center", gap: 8,
                  cursor: "pointer", transition: "all 0.15s",
                }}>
                ↗ Manage Position
              </a>
            )}
          </div>
        </div>

      </main>
    </div>
  );
}
