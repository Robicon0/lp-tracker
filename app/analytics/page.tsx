"use client";

import { useMemo, useEffect, useState, type CSSProperties } from "react";
import Link from "next/link";
import TerminalNavbar from "../components/TerminalNavbar";
import AnalyticsSidebar, { type AnalyticsSection } from "../components/AnalyticsSidebar";
import { usePositions } from "../contexts/PositionsContext";
import { useLendingPositions, type ExternalLendingPosition } from "../hooks/useLendingPositions";
import { useAllPositionsActivity } from "../hooks/useAllPositionsActivity";
import InfoTooltip from "../components/InfoTooltip";
import { useWalletLevelFees } from "../hooks/useWalletLevelFees";
import { useLpPnl } from "../hooks/useLpPnl";
import { useWalletTokens } from "../hooks/useWalletTokens";
import { useAaveV3Rates } from "../hooks/useAaveV3Rates";
import { useAccount } from "wagmi";
import { useWalletAuth } from "../contexts/WalletAuthContext";
import { useWatchedWallets } from "../contexts/WatchedWalletsContext";
import {
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Area,
  AreaChart,
} from "recharts";

// ── Terminal palette (matches analytics.html exactly) ─────────────────────────
const C = {
  bg:         "#000000",
  bg1:        "#060606",
  bg2:        "#0a0a0a",
  bg3:        "#101010",
  bg4:        "#161616",
  border:     "#1c1c1c",
  borderHi:   "#262626",
  text:       "#a8a8a8",
  textMid:    "#d0d0d0",
  textBright: "#ffffff",
  textWhite:  "#ffffff",
  green:      "#00ff41",
  greenDim:   "#00cc33",
  greenFaint: "rgba(0,255,65,0.06)",
  greenGlow:  "rgba(0,255,65,0.18)",
  cyan:       "#00d4ff",
  cyanFaint:  "rgba(0,212,255,0.07)",
  red:        "#ff3355",
  redFaint:   "rgba(255,51,85,0.07)",
  amber:      "#ffaa00",
  purple:     "#9945ff",
  blue:       "#3d9fff",
} as const;

const FONT = "'JetBrains Mono','Courier New',monospace";

const SCANLINE_BG =
  "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.025) 2px, rgba(0,0,0,0.025) 4px)";

const PROTOCOL_COLORS: Record<string, string> = {
  Aerodrome:      C.green,
  "Uniswap V3":   C.cyan,
  Velodrome:      C.blue,
  Orca:           C.amber,
  Raydium:        C.red,
  Cetus:          C.cyan,
  Bluefin:        C.blue,
  Momentum:       C.green,
  HyperSwap:      C.amber,
  KittenSwap:     C.purple,
  ProjectX:       C.purple,
  PRJX:           C.purple,
  PancakeSwap:    C.amber,
  Dolomite:       "#6366f1",
  "Jupiter Lend": C.purple,
  AlphaFi:        "#14b8a6",
  Suilend:        C.cyan,
  HyperLend:      C.green,
  HypurrFi:       C.amber,
  Kamino:         C.purple,
  "AAVE V3":      "#b6509e",
};

const CHAIN_COLORS: Record<string, string> = {
  Base:        C.blue,
  Ethereum:    C.cyan,
  Arbitrum:    C.green,
  Optimism:    "#ff0420",
  Polygon:     C.purple,
  Avalanche:   "#e84142",
  Solana:      C.purple,
  Sui:         C.blue,
  HyperEVM:    "#00d4aa",
  "BNB Chain": C.amber,
};

const PIE_COLORS = [C.green, C.cyan, C.blue, C.amber, C.purple, C.red, "#14b8a6", "#ec4899", "#6366f1", "#84cc16"];

const TIME_RANGES = [
  { key: "1D",   ms: 1   * 24 * 3_600_000, label: "24h",     xFmt: (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) },
  { key: "7D",   ms: 7   * 24 * 3_600_000, label: "7 days",  xFmt: (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) },
  { key: "30D",  ms: 30  * 24 * 3_600_000, label: "30 days", xFmt: (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) },
  { key: "90D",  ms: 90  * 24 * 3_600_000, label: "90 days", xFmt: (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) },
  { key: "1Y",   ms: 365 * 24 * 3_600_000, label: "1 year",  xFmt: (d: Date) => d.toLocaleDateString("en-US", { month: "short", year: "2-digit" }) },
] as const;

type RangeKey = typeof TIME_RANGES[number]["key"];

// ── Helpers ──────────────────────────────────────────────────────────────────
const fmt$ = (n: number, dec = 2) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;

const fmt$Signed = (n: number, dec = 2) =>
  `${n >= 0 ? "+" : "-"}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;

const fmtCompact = (n: number) => {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return fmt$(n, 0);
};

const tooltipStyle: CSSProperties = {
  background: C.bg1,
  border: `1px solid ${C.borderHi}`,
  padding: "8px 12px",
  color: C.textBright,
  fontSize: 14,
  fontFamily: FONT,
};

// ── Sort config for position table ───────────────────────────────────────────
type SortKey = "value" | "apy" | "daily" | "fees" | "protocol" | "chain";
type SortDir = "asc" | "desc";

// Fallback AAVE V3 supply APYs (used only when live rate fetch fails)
const FALLBACK_AAVE_SUPPLY_APY: Record<string, number> = {
  USDC: 2.86, USDbC: 2.86, "USDC.e": 2.86,
  USDT: 3.50, DAI: 2.20,
  WETH: 1.80, ETH: 1.80,
  WBTC: 0.80, cbBTC: 0.80,
};

function getAaveUnderlying(symbol: string): string {
  const rest = symbol.startsWith("a") ? symbol.slice(1) : symbol;
  for (const prefix of ["Bas", "Arb", "Opt", "Eth", "Pol"]) {
    if (rest.startsWith(prefix)) return rest.slice(prefix.length);
  }
  return rest;
}

function getATokenChain(symbol: string): string | null {
  const rest = symbol.startsWith("a") ? symbol.slice(1) : null;
  if (!rest) return null;
  if (rest.startsWith("Bas")) return "Base";
  if (rest.startsWith("Arb")) return "Arbitrum";
  if (rest.startsWith("Opt")) return "Optimism";
  if (rest.startsWith("Eth")) return "Ethereum";
  if (rest.startsWith("Pol")) return "Polygon";
  return null;
}

function tokenInitials(pair: string): string {
  const parts = pair.split("/").map((s) => s.trim());
  return `${(parts[0] ?? "?").slice(0, 2)}${(parts[1] ?? "?").slice(0, 1)}`.toUpperCase();
}

// ── ChainTag — small color-coded badge ───────────────────────────────────────
function ChainTag({ chain }: { chain: string }) {
  const color = CHAIN_COLORS[chain] ?? C.text;
  return (
    <span
      style={{
        fontSize: 10,
        padding: "1px 6px",
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        border: `1px solid ${color}44`,
        background: `${color}11`,
        color,
        fontWeight: 700,
        fontFamily: FONT,
      }}
    >
      {chain}
    </span>
  );
}

// ── ExposureCard — donut + right-side legend (terminal aesthetic) ────────────
type ExposureRow = { name: string; value: number };

interface ExposureCardProps {
  title: string;
  warning?: string | null;
  data: ExposureRow[];
  colorOf: (name: string, i: number) => string;
  centerPrimary: string;
  centerSecondary: string;
  valueFmt: (v: number) => string;
}

function ExposureCard({
  title, warning, data, colorOf, centerPrimary, centerSecondary, valueFmt,
}: ExposureCardProps) {
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const total = data.reduce((s, r) => s + r.value, 0);
  const colored = data.map((r, i) => ({ ...r, color: colorOf(r.name, i) }));

  return (
    <div
      style={{
        border: `1px solid ${C.border}`,
        background: C.bg1,
        padding: "24px 28px",
        fontFamily: FONT,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
        <div
          style={{
            fontSize: 11,
            letterSpacing: "0.2em",
            textTransform: "uppercase",
            color: C.textMid,
          }}
        >
          <span style={{ color: C.green }}>// </span>{title}
        </div>
        {warning && (
          <span
            style={{
              fontSize: 10,
              padding: "2px 8px",
              border: `1px solid ${C.amber}44`,
              background: `${C.amber}11`,
              color: C.amber,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              fontWeight: 700,
            }}
          >
            {warning}
          </span>
        )}
      </div>

      {data.length === 0 ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 220, color: C.text, fontSize: 14 }}>
          No data
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
          <div style={{ width: 160, height: 160, flexShrink: 0, position: "relative" }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={colored}
                  cx="50%"
                  cy="50%"
                  outerRadius={75}
                  innerRadius={50}
                  dataKey="value"
                  paddingAngle={2}
                  stroke={C.bg}
                  strokeWidth={2}
                  onMouseEnter={(_, i) => setActiveIdx(i)}
                  onMouseLeave={() => setActiveIdx(null)}
                >
                  {colored.map((entry, i) => (
                    <Cell
                      key={entry.name}
                      fill={entry.color}
                      opacity={activeIdx == null || activeIdx === i ? 1 : 0.3}
                    />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                pointerEvents: "none",
                padding: "0 8px",
                textAlign: "center",
              }}
            >
              {activeIdx != null && colored[activeIdx] ? (
                <>
                  <span style={{ fontSize: 10, letterSpacing: "0.15em", textTransform: "uppercase", color: C.text }}>
                    {colored[activeIdx].name}
                  </span>
                  <span style={{ fontSize: 16, fontWeight: 700, color: C.textBright, fontVariantNumeric: "tabular-nums" }}>
                    {valueFmt(colored[activeIdx].value)}
                  </span>
                  <span style={{ fontSize: 10, color: C.text }}>
                    {total > 0 ? ((colored[activeIdx].value / total) * 100).toFixed(1) : "0"}%
                  </span>
                </>
              ) : (
                <>
                  <span style={{ fontSize: 16, fontWeight: 700, color: C.textBright, fontVariantNumeric: "tabular-nums" }}>
                    {centerPrimary}
                  </span>
                  <span style={{ fontSize: 10, color: C.text, letterSpacing: "0.15em", textTransform: "uppercase", marginTop: 2 }}>
                    {centerSecondary}
                  </span>
                </>
              )}
            </div>
          </div>

          <div style={{ flex: 1, paddingLeft: 28, display: "flex", flexDirection: "column", gap: 8, maxHeight: 220, overflowY: "auto" }}>
            {colored.map((row, i) => {
              const pct = total > 0 ? (row.value / total) * 100 : 0;
              const isActive = activeIdx === i;
              return (
                <button
                  type="button"
                  key={row.name}
                  onMouseEnter={() => setActiveIdx(i)}
                  onMouseLeave={() => setActiveIdx(null)}
                  onFocus={() => setActiveIdx(i)}
                  onBlur={() => setActiveIdx(null)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "4px 6px",
                    fontFamily: FONT,
                    fontSize: 14.5,
                    background: isActive ? C.greenFaint : "transparent",
                    border: "none",
                    borderLeft: `2px solid ${isActive ? row.color : "transparent"}`,
                    color: C.textMid,
                    cursor: "default",
                    textAlign: "left",
                    width: "100%",
                  }}
                >
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      background: row.color,
                      flexShrink: 0,
                      boxShadow: `0 0 4px ${row.color}88`,
                    }}
                  />
                  <span style={{ flex: 1, letterSpacing: "0.02em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {row.name}
                  </span>
                  <span className="ana-exposure-pct" style={{ minWidth: 36, textAlign: "right", color: C.textBright, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                    {pct.toFixed(1)}%
                  </span>
                  <span className="ana-exposure-val" style={{ minWidth: 60, textAlign: "right", color: C.text, fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
                    {valueFmt(row.value)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Section frame ────────────────────────────────────────────────────────────
function SectionFrame({
  id, title, sub, action, children,
}: {
  id?: string;
  title: string;
  sub?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      style={{
        border: `1px solid ${C.border}`,
        background: C.bg1,
        marginBottom: 20,
        fontFamily: FONT,
        animation: "_fadeUp 0.45s ease both",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "18px 26px",
          borderBottom: `1px solid ${C.border}`,
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: C.textWhite, letterSpacing: "0.04em" }}>
            <span style={{ color: C.green }}>// </span>{title}
          </div>
          {sub && <div style={{ fontSize: 14, color: C.text, marginTop: 4, letterSpacing: "0.04em" }}>{sub}</div>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

// ── Range pill (chart tab) ───────────────────────────────────────────────────
function RangePill({
  k, active, onClick,
}: { k: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        fontFamily: FONT,
        fontSize: 11,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        padding: "5px 12px",
        cursor: "pointer",
        // Inline-only active state — never CSS classes. `border` shorthand
        // covers all 4 sides so no gap is possible.
        border: active ? "1px solid #00ff41" : "none",
        background: "transparent",
        color: active ? "#00ff41" : C.text,
      }}
    >
      {k}
    </button>
  );
}

// ── Skel — shimmer placeholder used across loading sections ───────────────
// Tiny pill-style div that animates the same `lp-pnl-shimmer` keyframe the
// LP P&L grid already uses. Width/height come in as props so callers can
// shape it to match the real value/chart they'll replace. The keyframe is
// declared in the page-wide <style> block below, so any Skel anywhere on
// the page picks it up.
function Skel({ w = 80, h = 20, r = 3, style }: { w?: number | string; h?: number | string; r?: number; style?: CSSProperties }) {
  return (
    <div
      aria-label="Loading"
      style={{
        width: w,
        height: h,
        borderRadius: r,
        background: "rgba(255,255,255,0.04)",
        animation: "lp-pnl-shimmer 1.4s linear infinite",
        backgroundImage:
          "linear-gradient(90deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0.08) 50%, rgba(255,255,255,0.02) 100%)",
        backgroundSize: "200% 100%",
        ...style,
      }}
    />
  );
}

// ── Component ────────────────────────────────────────────────────────────────
export default function Analytics() {
  const { positions, isLoading } = usePositions();
  const { positions: externalLendingPositions } = useLendingPositions();
  const { tokens: rawWalletTokens } = useWalletTokens();
  const { rates: aaveRates, prices: aavePrices } = useAaveV3Rates(rawWalletTokens);
  const walletTokens = useMemo(() => {
    return rawWalletTokens.map((t) => {
      if ((!t.isLending && !t.isDebt) || t.price > 0) return t;
      const live = aavePrices[t.contractAddress?.toLowerCase() ?? ""];
      if (!live || live <= 0) return t;
      return { ...t, price: live, usdValue: t.balance * live };
    });
  }, [rawWalletTokens, aavePrices]);

  const { address } = useAccount();
  const { solanaAddress, suiAddress } = useWalletAuth();
  const { watchedWallets } = useWatchedWallets();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const hasWallet = mounted && (!!(address || solanaAddress || suiAddress) || watchedWallets.length > 0);

  // ── AAVE lending positions ─────────────────────────────────────────────────
  const lendingPositions: ExternalLendingPosition[] = useMemo(() => {
    const aaveByChain = new Map<string, {
      supplied: number; supplyApy: number;
      borrowed: number; borrowApy: number;
    }>();
    for (const t of walletTokens) {
      if (!t.isLending && !t.isDebt) continue;
      const chain = getATokenChain(t.symbol) ?? t.chain;
      const prev = aaveByChain.get(chain) ?? { supplied: 0, supplyApy: 0, borrowed: 0, borrowApy: 0 };
      const addr = t.contractAddress?.toLowerCase();
      const live = addr ? aaveRates[addr] : undefined;
      const fallbackSupply = FALLBACK_AAVE_SUPPLY_APY[getAaveUnderlying(t.symbol)] ?? 0;
      if (t.isLending) {
        const tokenApy = live?.supplyApy ?? fallbackSupply;
        const newSupplied = prev.supplied + t.usdValue;
        prev.supplyApy = newSupplied > 0
          ? (prev.supplyApy * prev.supplied + tokenApy * t.usdValue) / newSupplied
          : 0;
        prev.supplied = newSupplied;
      } else if (t.isDebt) {
        const tokenApy = live?.borrowApy ?? 0;
        const newBorrowed = prev.borrowed + t.usdValue;
        prev.borrowApy = newBorrowed > 0
          ? (prev.borrowApy * prev.borrowed + tokenApy * t.usdValue) / newBorrowed
          : 0;
        prev.borrowed = newBorrowed;
      }
      aaveByChain.set(chain, prev);
    }
    const aavePositions: ExternalLendingPosition[] = [...aaveByChain.entries()]
      .filter(([, v]) => v.supplied > 0 || v.borrowed > 0)
      .map(([chain, v]) => ({
        protocol: "AAVE V3",
        chain,
        totalSupplied: v.supplied,
        totalBorrowed: v.borrowed,
        supplyApy: v.supplyApy,
        borrowApy: v.borrowApy,
        suppliedAssets: [],
        borrowedAssets: [],
        manageUrl: "https://app.aave.com",
      }));
    return [...aavePositions, ...externalLendingPositions];
  }, [walletTokens, aaveRates, externalLendingPositions]);

  // ── Activity data ──────────────────────────────────────────────────────────
  const { perfMap, eventsMap, isLoading: activityLoading } = useAllPositionsActivity(positions);
  const { events: walletLevelFees } = useWalletLevelFees(positions);
  const lpPnl = useLpPnl(positions);

  // ── Sort + view state ──────────────────────────────────────────────────────
  const [sortKey, setSortKey] = useState<SortKey>("value");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [aprView, setAprView] = useState<"daily" | "weekly" | "monthly" | "yearly">("yearly");
  const [rangeKey, setRangeKey] = useState<RangeKey>("30D");
  const [incomePeriod, setIncomePeriod] = useState<"D" | "M" | "Y">("D");
  const [chainPeriod, setChainPeriod] = useState<"1D" | "7D" | "30D">("1D");
  const [activeSection, setActiveSection] = useState<AnalyticsSection>("overview");

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  function handleSectionChange(id: AnalyticsSection) {
    setActiveSection(id);
    if (typeof document !== "undefined") {
      const el = document.getElementById(`section-${id}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  // ── Portfolio totals ──────────────────────────────────────────────────────
  const totalLpValue = positions.reduce((s, p) => s + p.value, 0);
  const totalLpFees  = positions.reduce((s, p) => s + p.fees, 0);
  const totalLendingValue = lendingPositions.reduce((s, p) => s + p.totalSupplied, 0);
  const totalPortfolioValue = totalLpValue + totalLendingValue;

  const activeRange   = TIME_RANGES.find((r) => r.key === rangeKey) ?? TIME_RANGES[2];
  const rangeCutoff   = Date.now() - activeRange.ms;

  // ── Fee income — aggregated from on-chain fee_claim / reward_claim ─────────
  const feeIncome = useMemo(() => {
    interface FlatFee { ts: number; usd: number; protocol: string; chain: string; dedupeKey: string; }
    const flat: FlatFee[] = [];
    const posById = new Map(positions.map((p) => [p.id, p]));

    const buildKey = (protocol: string, e: { txHash?: string; timestamp: number; amount0: number; amount1: number }) => {
      if (e.txHash) return `${protocol}::${e.txHash}::${e.amount0}::${e.amount1}`;
      return `${protocol}::ts${e.timestamp}::${e.amount0}::${e.amount1}`;
    };

    const push = (
      protocol: string,
      chain: string,
      e: { type: string; timestamp: number; amount0: number; amount1: number; usdAtTime: number | null; txHash?: string },
    ) => {
      if (e.type !== "fee_claim" && e.type !== "reward_claim") return;
      const usd = e.usdAtTime ?? 0;
      if (!Number.isFinite(usd) || usd <= 0) return;
      flat.push({
        ts: e.timestamp * 1000,
        usd,
        protocol,
        chain,
        dedupeKey: buildKey(protocol, e),
      });
    };

    for (const [posId, events] of eventsMap.entries()) {
      const pos = posById.get(posId);
      if (!pos) continue;
      for (const e of events) push(pos.protocol, pos.chain, e);
    }
    for (const t of walletLevelFees) push(t.protocol, t.chain, t.event);

    const seen = new Set<string>();
    const deduped = flat.filter((f) => {
      if (seen.has(f.dedupeKey)) return false;
      seen.add(f.dedupeKey);
      return true;
    });
    deduped.sort((a, b) => a.ts - b.ts);
    flat.length = 0;
    flat.push(...deduped);

    const totalAllTime = flat.reduce((s, f) => s + f.usd, 0);
    const inWindow = flat.filter((f) => f.ts >= rangeCutoff);
    const totalWindow = inWindow.reduce((s, f) => s + f.usd, 0);

    const now = Date.now();
    const series: { label: string; ts: number; value: number }[] = [];
    series.push({ ts: rangeCutoff, label: activeRange.xFmt(new Date(rangeCutoff)), value: 0 });
    let running = 0;
    for (const f of inWindow) {
      running += f.usd;
      series.push({ ts: f.ts, label: activeRange.xFmt(new Date(f.ts)), value: running });
    }
    if (series[series.length - 1].ts < now) {
      series.push({ ts: now, label: activeRange.xFmt(new Date(now)), value: running });
    }

    const byKey = new Map<string, { protocol: string; chain: string; usd: number }>();
    for (const f of inWindow) {
      const k = `${f.protocol}::${f.chain}`;
      const prev = byKey.get(k) ?? { protocol: f.protocol, chain: f.chain, usd: 0 };
      prev.usd += f.usd;
      byKey.set(k, prev);
    }
    const protocols = Array.from(byKey.values())
      .filter((p) => p.usd > 0)
      .map((p) => ({ ...p, pct: totalWindow > 0 ? (p.usd / totalWindow) * 100 : 0 }))
      .sort((a, b) => b.usd - a.usd);

    // Recent fee claims for the Earning Flows section
    const recent = [...flat].sort((a, b) => b.ts - a.ts).slice(0, 8);

    // Peak day + daily avg + hourly within range
    const hoursInWindow = activeRange.ms / 3_600_000;
    const daysInWindow = activeRange.ms / 86_400_000;
    const hourlyRate = totalWindow / Math.max(hoursInWindow, 1);
    const dailyAvg = totalWindow / Math.max(daysInWindow, 1);
    const annualizedAtRate = hourlyRate * 24 * 365;

    const byDay = new Map<string, number>();
    for (const f of inWindow) {
      const d = new Date(f.ts).toISOString().slice(0, 10);
      byDay.set(d, (byDay.get(d) ?? 0) + f.usd);
    }
    const peakDay = Math.max(0, ...Array.from(byDay.values()));

    return { totalAllTime, totalWindow, series, protocols, recent, hourlyRate, dailyAvg, annualizedAtRate, peakDay };
  }, [eventsMap, positions, rangeCutoff, activeRange, walletLevelFees]);

  // ── Daily income ───────────────────────────────────────────────────────────
  const { dailyLpIncome, dailyLendingIncome } = useMemo(() => {
    const activeLp = positions.filter((p) => p.apy > 0 && p.value > 0);
    const yearlyLp = activeLp.reduce((s, p) => s + (p.value * p.apy) / 100, 0);
    let yearlyLending = 0;
    for (const lp of lendingPositions) {
      if (lp.supplyApy != null && lp.totalSupplied > 0) {
        yearlyLending += (lp.totalSupplied * lp.supplyApy) / 100;
      }
    }
    return { dailyLpIncome: yearlyLp / 365, dailyLendingIncome: yearlyLending / 365 };
  }, [positions, lendingPositions]);

  const totalDailyIncome = dailyLpIncome + dailyLendingIncome;

  const incomeWindow = useMemo(() => {
    const periodDays = incomePeriod === "D" ? 1 : incomePeriod === "M" ? 30 : 365;
    const lpAccrued = dailyLpIncome * periodDays;
    const lendingProjected = dailyLendingIncome * periodDays;
    return { lpAccrued, lendingProjected, total: lpAccrued + lendingProjected };
  }, [incomePeriod, dailyLpIncome, dailyLendingIncome]);

  // ── Actual APR (value-weighted) ────────────────────────────────────────────
  const actualAPRData = useMemo(() => {
    const activeWithValue = positions.filter((p) => p.value > 0 && p.status !== "Closed");
    if (activeWithValue.length === 0) return { apr: 0, totalValue: 0 };
    let weightedSum = 0;
    let totalVal = 0;
    for (const p of activeWithValue) {
      const perf = perfMap.get(p.id);
      const apr = perf?.actualAPR ?? p.apy;
      if (apr > 0) {
        weightedSum += apr * p.value;
        totalVal += p.value;
      }
    }
    return { apr: totalVal > 0 ? weightedSum / totalVal : 0, totalValue: totalVal };
  }, [positions, perfMap]);

  // ── Portfolio health score ─────────────────────────────────────────────────
  const healthScore = useMemo(() => {
    const activePositions = positions.filter((p) => p.value > 0 && p.status !== "Closed");
    if (activePositions.length === 0) return null;
    const inRangeCount = activePositions.filter((p) => p.status === "In Range").length;
    const inRangeScore = (inRangeCount / activePositions.length) * 40;
    let aprWeightedSum = 0;
    let aprTotalVal = 0;
    for (const p of activePositions) {
      const perf = perfMap.get(p.id);
      const apr = perf?.actualAPR ?? p.apy ?? 0;
      if (apr > 0) {
        aprWeightedSum += apr * p.value;
        aprTotalVal += p.value;
      }
    }
    const avgAPR = aprTotalVal > 0 ? aprWeightedSum / aprTotalVal : 0;
    const feeScore = Math.max(0, Math.min(1, avgAPR / 20)) * 25;
    const chains = new Set(activePositions.map((p) => p.chain));
    const chainFraction = chains.size >= 3 ? 1 : chains.size === 2 ? 0.85 : 0.6;
    const chainScore = chainFraction * 20;
    const ilPct = lpPnl.initialValue > 0 ? (lpPnl.ilUSD / lpPnl.initialValue) * 100 : 0;
    const ilMagnitude = Math.abs(Math.min(0, ilPct));
    const ilScore = Math.max(0, 1 - ilMagnitude / 5) * 15;
    return Math.round(inRangeScore + feeScore + chainScore + ilScore);
  }, [positions, perfMap, lpPnl.initialValue, lpPnl.ilUSD]);

  // ── Chain / protocol breakdowns ────────────────────────────────────────────
  const chainExposure = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of positions) {
      if (p.value > 0) m[p.chain] = (m[p.chain] ?? 0) + p.value;
    }
    for (const lp of lendingPositions) {
      if (lp.totalSupplied > 0) m[lp.chain] = (m[lp.chain] ?? 0) + lp.totalSupplied;
    }
    return Object.entries(m).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [positions, lendingPositions]);

  const protocolExposure = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of positions) {
      if (p.value > 0) m[p.protocol] = (m[p.protocol] ?? 0) + p.value;
    }
    for (const lp of lendingPositions) {
      if (lp.totalSupplied > 0) m[lp.protocol] = (m[lp.protocol] ?? 0) + lp.totalSupplied;
    }
    return Object.entries(m).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [positions, lendingPositions]);

  const incomeByChain = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of positions) {
      if (p.status === "Closed" || p.value <= 0) continue;
      if (p.apy > 0) {
        const daily = (p.value * p.apy) / 100 / 365;
        m[p.chain] = (m[p.chain] ?? 0) + daily;
      } else if (!(p.chain in m)) {
        m[p.chain] = 0;
      }
    }
    return Object.entries(m).map(([chain, daily]) => ({ chain, daily })).sort((a, b) => b.daily - a.daily);
  }, [positions]);

  // ── Sorted position table ──────────────────────────────────────────────────
  const sortedPositions = useMemo(() => {
    const STATUS_ORDER: Record<string, number> = { "In Range": 0, "Out of Range": 1 };
    const items = positions
      .filter((p) => p.status !== "Closed" && p.value > 0)
      .map((p) => {
        const perf = perfMap.get(p.id);
        const displayAPR = perf?.actualAPR ?? p.apy;
        const displayDaily = perf?.actualDaily ?? (p.apy > 0 && p.value > 0 ? (p.value * p.apy) / 100 / 365 : 0);
        const isEstimated = !perf || perf.isEstimated;
        return { ...p, displayAPR, displayDaily, isEstimated };
      });
    return [...items].sort((a, b) => {
      const sa = STATUS_ORDER[a.status] ?? 1;
      const sb = STATUS_ORDER[b.status] ?? 1;
      if (sa !== sb) return sa - sb;
      let cmp = 0;
      switch (sortKey) {
        case "value":    cmp = a.value - b.value; break;
        case "apy":      cmp = a.displayAPR - b.displayAPR; break;
        case "daily":    cmp = a.displayDaily - b.displayDaily; break;
        case "fees":     cmp = a.fees - b.fees; break;
        case "protocol": cmp = a.protocol.localeCompare(b.protocol); break;
        case "chain":    cmp = a.chain.localeCompare(b.chain); break;
      }
      return sortDir === "desc" ? -cmp : cmp;
    });
  }, [positions, sortKey, sortDir, perfMap]);

  const { topPerformers, bottomPerformers } = useMemo(() => {
    const active = positions.filter((p) => p.value > 0).map((p) => {
      const perf = perfMap.get(p.id);
      const displayAPR = perf?.actualAPR ?? p.apy;
      const isEstimated = !perf || perf.isEstimated;
      return { ...p, displayAPR, isEstimated };
    }).filter((p) => p.displayAPR > 0);
    const sorted = [...active].sort((a, b) => b.displayAPR - a.displayAPR);
    return { topPerformers: sorted.slice(0, 3), bottomPerformers: sorted.slice(-3).reverse() };
  }, [positions, perfMap]);

  const chainWarning = useMemo(() => {
    if (chainExposure.length === 0 || totalPortfolioValue === 0) return null;
    const top = chainExposure[0];
    const pct = (top.value / totalPortfolioValue) * 100;
    return pct > 70 ? `${pct.toFixed(0)}% on ${top.name}` : null;
  }, [chainExposure, totalPortfolioValue]);

  const protocolWarning = useMemo(() => {
    if (protocolExposure.length === 0 || totalPortfolioValue === 0) return null;
    const top = protocolExposure[0];
    const pct = (top.value / totalPortfolioValue) * 100;
    return pct > 50 ? `${pct.toFixed(0)}% in ${top.name}` : null;
  }, [protocolExposure, totalPortfolioValue]);

  // ── Active protocol / chain sets for sidebar ───────────────────────────────
  const activeProtocols = useMemo(() => {
    const s = new Set<string>();
    for (const p of positions) if (p.value > 0) s.add(p.protocol);
    for (const lp of lendingPositions) if (lp.totalSupplied > 0) s.add(lp.protocol);
    return s;
  }, [positions, lendingPositions]);

  const activeChains = useMemo(() => {
    const s = new Set<string>();
    for (const p of positions) if (p.value > 0) s.add(p.chain);
    for (const lp of lendingPositions) if (lp.totalSupplied > 0) s.add(lp.chain);
    return s;
  }, [positions, lendingPositions]);

  // ── Empty / no-wallet state ────────────────────────────────────────────────
  // NOTE: the previous `if (isLoading) return <Loading>` gate that blocked
  // the entire page until positions arrived is REMOVED. Page hero + section
  // frames now render instantly; per-section data shows shimmer skeletons
  // (`<Skel />`) until its specific source resolves, so the user sees the
  // page populate progressively rather than waiting on the slowest RPC.
  // The no-wallet gate below stays — without a wallet there's literally
  // nothing to compute.

  if (mounted && !hasWallet) {
    return (
      <div style={{ background: C.bg, color: C.text, minHeight: "100vh", fontFamily: FONT, display: "flex", flexDirection: "column", paddingTop: 52 }}>
        <TerminalNavbar />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: 40 }}>
          <div
            style={{
              width: 64, height: 64, marginBottom: 24,
              background: C.greenFaint,
              border: `1px solid ${C.greenDim}`,
              display: "flex", alignItems: "center", justifyContent: "center",
              color: C.green, fontSize: 32,
            }}
          >
            ◎
          </div>
          <h1 style={{ fontSize: 28, fontWeight: 700, color: C.textWhite, marginBottom: 10, letterSpacing: "-0.02em" }}>
            Portfolio Analytics
          </h1>
          <p style={{ color: C.text, maxWidth: 360, fontSize: 15 }}>
            Connect a wallet to view analytics and performance data for your DeFi positions.
          </p>
        </div>
      </div>
    );
  }

  const SortIcon = ({ col }: { col: SortKey }) => (
    <span style={{ marginLeft: 4, fontSize: 10 }}>
      {sortKey === col ? (sortDir === "desc" ? "▼" : "▲") : "▼"}
    </span>
  );

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: "100vh",
        background: C.bg,
        color: C.text,
        fontFamily: FONT,
        fontSize: 16.5,
        lineHeight: 1.55,
        overflowX: "hidden",
        paddingTop: 52,
      }}
    >
      <style>{`
        @keyframes _spin   { from { transform:rotate(0deg) } to { transform:rotate(360deg) } }
        @keyframes _pulse  { 0%,100%{opacity:1} 50%{opacity:0.25} }
        @keyframes _fadeUp { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
        @keyframes lp-pnl-shimmer { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }
        .spin-icon { display:inline-block; animation: _spin 1s linear infinite; }
        .a-row:hover td { background: rgba(255,255,255,0.012); }
        /* Toggle styling is now 100% inline on every button (RangePill,
           aprView D/W/M/Y, incomePeriod D/M/Y, chainPeriod 1D/7D/30D). No
           .ct-tab CSS rules — eliminates the inline-vs-CSS specificity
           conflicts that caused the active state to render with gaps. */
        .icon-btn { transition: all 0.12s; }
        .icon-btn:hover { border-color: ${C.cyan}; color: ${C.cyan}; }
        .sort-th { transition: color 0.1s; }
        .sort-th:hover { color: ${C.textMid}; }
        .analyze-btn:hover { border-color: ${C.cyan}; color: ${C.cyan}; background: ${C.cyanFaint}; }
        .scroll-thin::-webkit-scrollbar { width: 4px; height: 4px; }
        .scroll-thin::-webkit-scrollbar-thumb { background: ${C.borderHi}; }
        .docs-help-btn:hover { color: ${C.green} !important; border-color: ${C.green} !important; background: ${C.bg2} !important; }

        /* ── Mobile layout (max-width: 768px) ────────────────────────────
           CSS-only — no logic, no data, no functionality changes. */
        @media (max-width: 768px) {
          .docs-help-btn { display: none !important; }
          /* 6 cells collapse to 2 columns × 3 rows on mobile. */
          .ana-lp-pnl { grid-template-columns: 1fr 1fr !important; }
          .ana-income-pair { grid-template-columns: 1fr !important; }
          .ana-income-source-inner { flex-direction: column !important; }
          .ana-chain-mo { display: none !important; }
          .ana-col-value,
          .ana-col-daily,
          .ana-col-fees,
          .ana-col-status,
          .ana-col-analyze { display: none !important; }
          /* Position column MUST stay visible. Hidden columns above use
             display:none; the explicit table-cell here is paranoid but
             prevents any future blanket hide rule from clipping it. Tighter
             padding so the icon+pair-name fits on a 390px viewport. */
          .ana-col-position {
            display: table-cell !important;
            padding-left: 12px !important;
            padding-right: 8px !important;
          }
          .ana-flow-row { padding: 10px 12px !important; gap: 8px !important; }
          .ana-flow-time { display: none !important; }
          /* "FEE CLAIM" label was wrapping to 2 lines on phones because the
             flex:1 cell shrank below the text's natural width (10px font ×
             0.14em letter-spacing). Force single line — overflow clips
             cleanly since the row already constrains width. */
          .ana-flow-label { white-space: nowrap !important; overflow: hidden !important; }
          #section-exposure { grid-template-columns: 1fr !important; }
          /* ExposureCard legend rows: the percentage and value spans
             shrink below their min-widths in flex layout, clipping the
             numbers. Drop both to 11px on phones (the value span is
             already 11px on desktop; matching the percentage prevents the
             flex shrink from clipping). */
          .ana-exposure-pct,
          .ana-exposure-val { font-size: 11px !important; flex-shrink: 0 !important; }
          .ana-rankings-grid { grid-template-columns: 1fr !important; }
          .ana-rankings-top {
            border-right: none !important;
            border-bottom: 1px solid #1c1c1c;
          }
        }
      `}</style>

      <div
        aria-hidden
        style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 9998, background: SCANLINE_BG }}
      />

      <TerminalNavbar />

      <div style={{ display: "flex", flex: 1, minHeight: "calc(100vh - 52px)" }}>
        <AnalyticsSidebar
          activeSection={activeSection}
          onSectionChange={handleSectionChange}
          activeProtocols={activeProtocols}
          activeChains={activeChains}
        />

        <main className="scroll-thin md:ml-[200px]" style={{ flex: 1, overflowY: "auto", background: C.bg, minWidth: 0 }}>

          {/* ── PAGE HEADER ─────────────────────────────────────────────── */}
          <section
            id="section-overview"
            style={{
              padding: "26px 32px 22px",
              borderBottom: `1px solid ${C.border}`,
              animation: "_fadeUp 0.4s ease both",
              position: "relative",
            }}
          >
            <a
              href="/docs"
              target="_blank"
              rel="noopener noreferrer"
              title="Documentation"
              aria-label="Documentation"
              className="docs-help-btn"
              style={{
                position: "absolute",
                top: 26,
                right: 32,
                background: "transparent",
                border: `1px solid ${C.borderHi}`,
                color: C.text,
                width: 32,
                height: 32,
                fontSize: 11,
                fontWeight: 600,
                fontFamily: FONT,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                textDecoration: "none",
                cursor: "pointer",
                transition: "color 0.15s, border-color 0.15s, background 0.15s",
              }}
            >
              ?
            </a>
            <div style={{ fontSize: 11, color: C.text, letterSpacing: "0.22em", textTransform: "uppercase", marginBottom: 8 }}>
              // <span style={{ color: C.green }}>analytics</span> · performance insights &amp; attribution
            </div>
            <div style={{ fontSize: 28, fontWeight: 700, color: C.textWhite, letterSpacing: "-0.02em", marginBottom: 6 }}>
              Analytics
            </div>
            <div style={{ fontSize: 15, color: C.text, letterSpacing: "0.04em" }}>
              Portfolio insights and performance metrics across all chains
            </div>
          </section>

          {/* ── CONTENT ───────────────────────────────────────────────────
              Horizontal padding removed (was "20px 32px 32px") so analytics
              sections sit flush against <main>'s edges — same look as
              dashboard, where sections are direct children of <main> with
              no outer padding wrapper. Vertical breathing room is kept
              (20px top / 32px bottom). */}
          <div style={{ padding: "20px 0 32px" }}>

            {/* TOP STATS STRIP — 5 cells */}
            <div
              className="ana-top-stats"
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(5, 1fr)",
                border: `1px solid ${C.border}`,
                background: C.bg1,
                marginBottom: 20,
              }}
            >
              {/* Total Portfolio */}
              <div style={{ padding: "18px 22px", borderRight: `1px solid ${C.border}` }}>
                <div style={{ fontSize: 11, color: C.text, letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 10 }}>
                  Total Portfolio
                </div>
                {isLoading ? <Skel w={120} h={28} /> : (
                  <div style={{ fontSize: 28, fontWeight: 700, color: C.textBright, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }}>
                    {fmtCompact(totalPortfolioValue)}
                  </div>
                )}
                <div style={{ fontSize: 11, marginTop: 6, color: C.text, letterSpacing: "0.06em" }}>
                  {isLoading ? <Skel w={140} h={11} /> : <>LP {fmtCompact(totalLpValue)}{totalLendingValue > 0 ? ` · Lending ${fmtCompact(totalLendingValue)}` : ""}</>}
                </div>
              </div>

              {/* Daily Income */}
              <div style={{ padding: "18px 22px", borderRight: `1px solid ${C.border}` }}>
                <div style={{ fontSize: 11, color: C.text, letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 10 }}>
                  Daily Income
                </div>
                {isLoading ? <Skel w={100} h={28} /> : (
                  <div
                    style={{
                      fontSize: 28, fontWeight: 700,
                      color: totalDailyIncome > 0 ? C.green : C.text,
                      fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em",
                      textShadow: totalDailyIncome > 0 ? "0 0 18px rgba(0,255,65,0.22)" : "none",
                    }}
                  >
                    {totalDailyIncome > 0 ? `+${fmt$(totalDailyIncome)}` : "$0.00"}
                  </div>
                )}
                <div style={{ fontSize: 11, marginTop: 6, color: C.text, letterSpacing: "0.06em" }}>
                  {isLoading ? <Skel w={120} h={11} /> : (totalDailyIncome > 0 ? `${fmt$(totalDailyIncome * 30)}/mo` : "No active positions")}
                </div>
              </div>

              {/* Unclaimed Fees */}
              <div style={{ padding: "18px 22px", borderRight: `1px solid ${C.border}` }}>
                <div style={{ fontSize: 11, color: C.text, letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 10 }}>
                  Unclaimed Fees
                </div>
                {isLoading ? <Skel w={100} h={28} /> : (
                  <div style={{ fontSize: 28, fontWeight: 700, color: C.textBright, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }}>
                    {fmt$(totalLpFees)}
                  </div>
                )}
                <div style={{ fontSize: 11, marginTop: 6, color: C.text, letterSpacing: "0.06em" }}>
                  {isLoading ? <Skel w={140} h={11} /> : `${positions.filter((p) => p.fees > 0).length} positions with fees`}
                </div>
              </div>

              {/* Actual APR — with D/W/M/Y toggle */}
              <div style={{ padding: "18px 22px", borderRight: `1px solid ${C.border}` }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                  <span style={{ fontSize: 11, color: C.text, letterSpacing: "0.2em", textTransform: "uppercase" }}>
                    Actual APR
                  </span>
                  <div style={{ display: "flex" }}>
                    {(["daily", "weekly", "monthly", "yearly"] as const).map((v) => {
                      const active = aprView === v;
                      return (
                        <button
                          key={v}
                          type="button"
                          onClick={() => setAprView(v)}
                          style={{
                            fontFamily: FONT,
                            fontSize: 10,
                            padding: "2px 6px",
                            cursor: "pointer",
                            letterSpacing: "0.1em",
                            textTransform: "uppercase",
                            // Inline-only active state — border shorthand
                            // covers all 4 sides so no gap is possible.
                            border: active ? "1px solid #00ff41" : "none",
                            background: "transparent",
                            color: active ? "#00ff41" : C.text,
                          }}
                        >
                          {v === "daily" ? "D" : v === "weekly" ? "W" : v === "monthly" ? "M" : "Y"}
                        </button>
                      );
                    })}
                  </div>
                </div>
                {(() => {
                  const apr = actualAPRData.apr;
                  const displayRate = aprView === "daily" ? apr / 365
                    : aprView === "weekly" ? apr / 52
                    : aprView === "monthly" ? apr / 12
                    : apr;
                  const yearlyDollar = (actualAPRData.totalValue * apr) / 100;
                  const dollarIncome = aprView === "daily" ? yearlyDollar / 365
                    : aprView === "weekly" ? yearlyDollar / 52
                    : aprView === "monthly" ? yearlyDollar / 12
                    : yearlyDollar;
                  const periodLabel = aprView === "daily" ? "/day"
                    : aprView === "weekly" ? "/week"
                    : aprView === "monthly" ? "/mo"
                    : "/year";
                  if (isLoading || activityLoading) {
                    return (
                      <>
                        <Skel w={100} h={28} />
                        <div style={{ marginTop: 6 }}><Skel w={120} h={11} /></div>
                      </>
                    );
                  }
                  return (
                    <>
                      <div style={{
                        fontSize: 28, fontWeight: 700,
                        color: apr > 0 ? C.green : C.text,
                        fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em",
                        textShadow: apr > 0 ? "0 0 18px rgba(0,255,65,0.22)" : "none",
                      }}>
                        {apr > 0 ? `${displayRate.toFixed(displayRate < 1 ? 3 : 1)}%` : "--"}
                      </div>
                      <div style={{ fontSize: 11, marginTop: 6, color: C.text, letterSpacing: "0.06em" }}>
                        {apr > 0 ? `${fmt$(dollarIncome)}${periodLabel}` : "No active positions"}
                      </div>
                    </>
                  );
                })()}
              </div>

              {/* Health Score */}
              <div style={{ padding: "18px 22px" }}>
                <div style={{ fontSize: 11, color: C.text, letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 10 }}>
                  Health Score
                </div>
                {isLoading || activityLoading ? (
                  <>
                    <Skel w={80} h={28} />
                    <div style={{ marginTop: 10 }}><Skel w="100%" h={2} r={0} /></div>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: 28, fontWeight: 700, color: C.cyan, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }}>
                      {healthScore != null ? healthScore : "--"}
                      <span style={{ fontSize: 15, color: C.text, marginLeft: 4 }}>/100</span>
                    </div>
                    <div style={{ width: "100%", height: 2, background: C.border, marginTop: 10 }}>
                      <div
                        style={{
                          height: "100%",
                          width: `${healthScore != null ? Math.max(0, Math.min(100, healthScore)) : 0}%`,
                          background: `linear-gradient(90deg, ${C.green}, ${C.cyan})`,
                          transition: "width 1.2s ease",
                        }}
                      />
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* ── FEE INCOME ────────────────────────────────────────────── */}
            <SectionFrame
              id="section-fee-income"
              title="Fee Income"
              sub="Cumulative fees collected across all LP positions"
            >
              {/* sub-metric strip */}
              <div
                className="ana-fee-sub"
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr 1fr 1fr",
                  borderBottom: `1px solid ${C.border}`,
                }}
              >
                {[
                  { label: `In Last ${activeRange.label}`, val: fmt$(feeIncome.totalWindow), green: true,  sub: `${feeIncome.protocols.length} protocols`, subUp: feeIncome.totalWindow > 0 },
                  { label: "Hourly Rate",                  val: fmt$(feeIncome.hourlyRate, 3), green: false, sub: "avg over period",     subUp: false },
                  { label: "Annualized",                   val: fmt$(feeIncome.annualizedAtRate, 0), green: true, sub: "at current rate",    subUp: false },
                  { label: "Lifetime",                     val: fmt$(feeIncome.totalAllTime), green: false, sub: "since inception",     subUp: false },
                ].map((c, i, arr) => (
                  <div
                    key={c.label}
                    style={{
                      padding: "16px 26px",
                      borderRight: i === arr.length - 1 ? "none" : `1px solid ${C.border}`,
                    }}
                  >
                    <div style={{ fontSize: 11, color: C.text, letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 8 }}>
                      {c.label}
                    </div>
                    {activityLoading ? <Skel w={100} h={28} /> : (
                      <div
                        style={{
                          fontSize: 28, fontWeight: 700,
                          color: c.green ? C.green : C.textBright,
                          fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em",
                          textShadow: c.green ? "0 0 18px rgba(0,255,65,0.22)" : "none",
                        }}
                      >
                        {c.val}
                      </div>
                    )}
                    <div style={{ fontSize: 11, marginTop: 6, letterSpacing: "0.06em", color: c.subUp ? C.green : C.text }}>
                      {activityLoading ? <Skel w={90} h={11} /> : c.sub}
                    </div>
                  </div>
                ))}
              </div>

              {/* chart + controls */}
              <div style={{ padding: "18px 26px 22px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 0, marginBottom: 14, flexWrap: "wrap" }}>
                  <div style={{ display: "flex" }}>
                    {TIME_RANGES.map((r, i) => (
                      <span key={r.key} style={{ borderRight: i === TIME_RANGES.length - 1 ? `1px solid ${rangeKey === r.key ? C.greenDim : C.border}` : undefined }}>
                        <RangePill k={r.key} active={rangeKey === r.key} onClick={() => setRangeKey(r.key)} />
                      </span>
                    ))}
                  </div>
                  <div style={{ marginLeft: "auto", display: "flex", gap: 22, flexWrap: "wrap" }}>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                      <span style={{ color: C.text, letterSpacing: "0.14em", textTransform: "uppercase", fontSize: 10 }}>Peak Day</span>
                      <span style={{ fontWeight: 700, color: C.green, fontSize: 14, fontVariantNumeric: "tabular-nums" }}>
                        {fmt$(feeIncome.peakDay)}
                      </span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                      <span style={{ color: C.text, letterSpacing: "0.14em", textTransform: "uppercase", fontSize: 10 }}>Avg/Day</span>
                      <span style={{ fontWeight: 700, color: C.textBright, fontSize: 14, fontVariantNumeric: "tabular-nums" }}>
                        {fmt$(feeIncome.dailyAvg)}
                      </span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                      <span style={{ color: C.text, letterSpacing: "0.14em", textTransform: "uppercase", fontSize: 10 }}>Projected 12M</span>
                      <span style={{ fontWeight: 700, color: C.green, fontSize: 14, fontVariantNumeric: "tabular-nums" }}>
                        {fmtCompact(feeIncome.annualizedAtRate)}
                      </span>
                    </div>
                  </div>
                </div>

                {feeIncome.series.length >= 2 && feeIncome.totalWindow > 0 ? (
                  <div style={{ width: "100%", height: 200 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={feeIncome.series}>
                        <defs>
                          <linearGradient id="feeGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={C.green} stopOpacity={0.24} />
                            <stop offset="60%" stopColor={C.green} stopOpacity={0.06} />
                            <stop offset="100%" stopColor={C.green} stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="4 8" stroke="rgba(255,255,255,0.04)" vertical={false} />
                        <XAxis dataKey="label" tick={{ fill: C.text, fontSize: 11, fontFamily: FONT }} axisLine={false} tickLine={false} />
                        <YAxis
                          tick={{ fill: C.text, fontSize: 11, fontFamily: FONT }}
                          tickFormatter={(v) => fmtCompact(v)}
                          axisLine={false}
                          tickLine={false}
                          width={48}
                        />
                        <Tooltip
                          contentStyle={tooltipStyle}
                          itemStyle={{ color: C.textBright }}
                          labelStyle={{ color: C.text }}
                          formatter={(value: number | undefined) => [fmt$(value ?? 0), "Cumulative"]}
                        />
                        <Area
                          type="monotone"
                          dataKey="value"
                          stroke={C.green}
                          strokeWidth={1.5}
                          fill="url(#feeGrad)"
                          dot={false}
                          activeDot={{ r: 4, fill: C.green, stroke: C.green }}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 160, color: C.text, fontSize: 14 }}>
                    {activityLoading ? "Loading on-chain fee history…" : `No fee claims in the last ${activeRange.label}`}
                  </div>
                )}

                {/* Protocol breakdown row */}
                {feeIncome.protocols.length > 0 && (
                  <div style={{ marginTop: 18 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                      <span style={{ fontSize: 11, color: C.text, letterSpacing: "0.18em", textTransform: "uppercase" }}>
                        By Protocol
                      </span>
                      <span style={{ fontSize: 11, color: C.text }}>scroll →</span>
                    </div>
                    <div style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 4 }} className="scroll-thin">
                      {feeIncome.protocols.map((p) => {
                        const color = PROTOCOL_COLORS[p.protocol] ?? C.green;
                        return (
                          <div
                            key={`${p.protocol}::${p.chain}`}
                            style={{
                              flexShrink: 0,
                              width: 190,
                              padding: "12px 14px",
                              background: C.bg2,
                              border: `1px solid ${C.border}`,
                              borderLeft: `3px solid ${color}`,
                            }}
                          >
                            <div style={{ fontSize: 15, fontWeight: 700, color: C.textBright, letterSpacing: "0.02em" }}>
                              {p.protocol}
                            </div>
                            <div style={{ fontSize: 11, color: C.text, marginTop: 3, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                              {p.chain}
                            </div>
                            <div style={{ fontSize: 20, fontWeight: 700, color, marginTop: 10, fontVariantNumeric: "tabular-nums" }}>
                              {fmt$(p.usd)}
                            </div>
                            <div style={{ fontSize: 11, color: C.text, marginTop: 3 }}>
                              {p.pct.toFixed(1)}% of {activeRange.label}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </SectionFrame>

            {/* ── LP PROFIT & LOSS ──────────────────────────────────────── */}
            <SectionFrame
              id="section-lp-pnl"
              title="LP Profit & Loss"
              sub="Aggregated from on-chain deposit & fee events across all LP positions"
              action={
                lpPnl.isLoading ? (
                  <span
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 6,
                      fontSize: 11, color: C.green, letterSpacing: "0.14em", textTransform: "uppercase",
                    }}
                  >
                    <span
                      className="spin-icon"
                      style={{
                        width: 10, height: 10,
                        border: `2px solid ${C.greenFaint}`,
                        borderTopColor: C.green,
                      }}
                    />
                    Loading
                  </span>
                ) : null
              }
            >
              <div
                className="ana-lp-pnl"
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(7, 1fr)",
                }}
              >
                {/* While ANY LP position is still being fetched/computed
                    (lpPnl.isLoading), every value cell shows a skeleton bar.
                    No partial totals reveal — the user only sees numbers once
                    all positions across all chains have completed. Failed
                    positions don't block this gate: useLpPnl's `errored`
                    counter increments and the red banner below explains
                    which positions couldn't load.

                    Scoping rule:
                      Total Deposited / Current Value / Fees Unclaimed / IL
                        → OPEN positions only (useLpPnl.aggregate excludes
                          closed positions from these fields by design).
                      Fees Collected → ALL positions (open + closed lifetime).
                      Capital G/L → CLOSED positions only, EVM whitelist
                        (HyperEVM, Base, Arbitrum, Optimism, Polygon,
                        Ethereum, BNB Chain). Solana / Sui skipped — their
                        on-chain close artifacts (NFT burn / Move object
                        destroy) make closingValue unreliable.
                      Net P&L = Current + Fees Collected + Fees Unclaimed
                                + Capital G/L − Total Deposited. */}
                {(() => {
                  // Fees Collected uses the LIFETIME number from the Fee Income
                  // pipeline (same eventsMap + walletLevelFees that drive the
                  // chart in SECTION 2). useLpPnl.feesCollected sees per-position
                  // events only; feeIncome.totalAllTime additionally folds in
                  // wallet-level Bluefin fees from destroyed Sui objects, so
                  // it's the authoritative lifetime fee total.
                  const lifetimeFeesCollected = feeIncome.totalAllTime;
                  // Net P&L folds in realised capital G/L from closed EVM
                  // positions (lpPnl.capitalGL = Σ closingValue − initialValue
                  // for closed positions whose chain is in the EVM whitelist).
                  // Without this term, a wallet that's churned its open
                  // positions would see Net P&L drop to ~0 even when fees +
                  // realised gains made the portfolio profitable.
                  const adjustedNetPnl =
                    lpPnl.currentValue + lifetimeFeesCollected + lpPnl.feesUnclaimed + lpPnl.capitalGL - lpPnl.initialValue;
                  const adjustedNetPnlPct =
                    lpPnl.initialValue > 0 ? (adjustedNetPnl / lpPnl.initialValue) * 100 : 0;
                  // IL tooltip — dynamic, built from live numbers (matches
                  // CLAUDE.md "LP P&L IL tooltip with real numbers" rule).
                  const ilUsdAbs = Math.abs(lpPnl.ilUSD);
                  const hodlValue = lpPnl.currentValue - lpPnl.ilUSD; // ilUSD = currentValue − hodlValue
                  const totalFeesEarned = lifetimeFeesCollected + lpPnl.feesUnclaimed;
                  const ilTooltip = lpPnl.ilUSD >= 0
                    ? `Your current LP value (${fmt$(lpPnl.currentValue)}) is higher than your HODL value (${fmt$(hodlValue)}) by ${fmt$(ilUsdAbs)}. The AMM rebalancing has worked in your favour. Combined with ${fmt$(totalFeesEarned)} fees earned your total return is strong.\n\nFormula: IL = Current LP Value − HODL Value`
                    : `Your current LP value (${fmt$(lpPnl.currentValue)}) is lower than your HODL value (${fmt$(hodlValue)}) by ${fmt$(ilUsdAbs)}. This is your impermanent loss. Your fees earned (${fmt$(totalFeesEarned)}) ${totalFeesEarned >= ilUsdAbs ? "fully" : "partially"} offset this loss. IL may recover if prices return to entry levels.\n\nFormula: IL = Current LP Value − HODL Value`;
                  return ([
                  {
                    label: "Total Deposited",
                    // "~" marker when an OPEN position contributing to the
                    // totals is using the HyperEVM fallback (current value as
                    // deposit estimate because eth_getLogs couldn't reach the
                    // deposit block). With HYPEREVM_ARCHIVE_RPC (Chainstack
                    // nanoreth, full history from block 0) wired in,
                    // estimatedPositionCount should be ~0 for HyperEVM —
                    // closed positions now reach Tier 2 successfully.
                    val: `${lpPnl.estimatedPositionCount > 0 ? "~" : ""}${fmt$(lpPnl.initialValue)}`,
                    color: C.textBright,
                    sub: "at deposit prices, open positions only",
                    tooltip: lpPnl.estimatedPositionCount > 0
                      ? `${lpPnl.estimatedPositionCount} position${lpPnl.estimatedPositionCount === 1 ? "" : "s"} using estimated deposit value — Deposit price unavailable, using current value as estimate.`
                      : undefined,
                  },
                  { label: "Current Value",   val: fmt$(lpPnl.currentValue),   color: C.textBright, sub: "open positions, mark-to-market" },
                  {
                    label: "Fees Collected",
                    val: `+${fmt$(lifetimeFeesCollected)}`,
                    color: C.green,
                    sub: "claimed lifetime (at claim-time price)",
                  },
                  { label: "Fees Unclaimed",  val: `+${fmt$(lpPnl.feesUnclaimed)}`, color: C.green, sub: "open positions, pending on-chain" },
                  {
                    label: "Capital G/L",
                    val: fmt$Signed(lpPnl.capitalGL),
                    color: lpPnl.capitalGL > 0 ? C.green : lpPnl.capitalGL < 0 ? C.red : C.textBright,
                    sub: "closed positions, EVM only",
                    tooltip: "Realized gain or loss from closed LP positions — difference between exit value and deposit value. EVM chains only (HyperEVM, Base, Arbitrum). Solana and Sui closed position exit data is not yet available on-chain.",
                  },
                  {
                    label: "Imperm. Loss",
                    val: fmt$Signed(-lpPnl.ilUSD),
                    color: -lpPnl.ilUSD > 0 ? C.red : C.green,
                    sub: "Σ(HODL − Current), open positions only",
                    tooltip: ilTooltip,
                  },
                  {
                    label: "Net P&L",
                    val: fmt$Signed(adjustedNetPnl),
                    color: adjustedNetPnl >= 0 ? C.cyan : C.red,
                    sub: `${adjustedNetPnlPct >= 0 ? "+" : ""}${adjustedNetPnlPct.toFixed(2)}%`,
                  },
                ] as Array<{ label: string; val: string; color: string; sub: string; tooltip?: string }>);
                })().map((c, i, arr) => (
                  <div
                    key={c.label}
                    style={{
                      padding: "16px 20px",
                      borderRight: i === arr.length - 1 ? "none" : `1px solid ${C.border}`,
                      position: "relative",
                    }}
                  >
                    <div style={{ fontSize: 11, color: C.text, letterSpacing: "0.16em", textTransform: "uppercase", marginBottom: 10, display: "flex", alignItems: "center" }}>
                      {c.label}
                      {c.tooltip && <InfoTooltip text={c.tooltip} />}
                    </div>
                    {lpPnl.isLoading ? (
                      <div
                        aria-label="Loading"
                        style={{
                          width: 100, height: 26,
                          background: "rgba(255,255,255,0.04)",
                          borderRadius: 3,
                          animation: "lp-pnl-shimmer 1.4s linear infinite",
                          backgroundImage:
                            "linear-gradient(90deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0.08) 50%, rgba(255,255,255,0.02) 100%)",
                          backgroundSize: "200% 100%",
                        }}
                      />
                    ) : (
                      <div
                        style={{
                          fontSize: 21, fontWeight: 700,
                          color: c.color,
                          fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em",
                          textShadow: c.color === C.green ? "0 0 12px rgba(0,255,65,0.22)" : "none",
                        }}
                      >
                        {c.val}
                      </div>
                    )}
                    <div style={{ fontSize: 11, marginTop: 5, color: C.text, letterSpacing: "0.04em" }}>
                      {lpPnl.isLoading ? "calculating…" : c.sub}
                    </div>
                  </div>
                ))}
              </div>
              <style
                dangerouslySetInnerHTML={{
                  __html:
                    "@keyframes lp-pnl-shimmer { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }",
                }}
              />

              {/* Excluded-positions warning — every position NOT contributing
                  to the totals (unsupported protocols, missing-data positions,
                  transport errors after retries). Shown only after loading
                  resolves so the user doesn't see it flash during fetch. */}
              {!lpPnl.isLoading && lpPnl.excludedPositions.length > 0 && (
                <div
                  style={{
                    margin: "0 26px 18px",
                    border: "1px solid rgba(255,170,0,0.25)",
                    background: "rgba(255,170,0,0.04)",
                    padding: "12px 16px",
                    fontFamily: FONT,
                  }}
                >
                  <div
                    style={{
                      fontSize: 12,
                      color: "#ffaa00",
                      letterSpacing: "0.04em",
                      marginBottom: 8,
                    }}
                  >
                    ⚠ {lpPnl.excludedPositions.length} position
                    {lpPnl.excludedPositions.length === 1 ? "" : "s"} could not
                    be fully calculated and {lpPnl.excludedPositions.length === 1 ? "is" : "are"} excluded from totals:
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {lpPnl.excludedPositions.map((ep) => (
                      <div
                        key={`${ep.id}-${ep.reason}`}
                        style={{
                          fontSize: 11,
                          color: "rgba(255,170,0,0.85)",
                          letterSpacing: "0.02em",
                          lineHeight: 1.55,
                        }}
                      >
                        <span style={{ color: "#ffaa00", fontWeight: 600 }}>
                          {ep.pair}
                        </span>
                        <span style={{ opacity: 0.7 }}>
                          {" "}({ep.protocol} · {ep.chain})
                        </span>
                        <span style={{ opacity: 0.7 }}> — </span>
                        <span>{ep.reason}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {lpPnl.errored > 0 && (
                <div
                  style={{
                    margin: "0 26px 18px",
                    border: `1px solid ${C.red}33`,
                    background: C.redFaint,
                    padding: "10px 14px",
                  }}
                >
                  <div style={{ fontSize: 14, color: C.red, fontWeight: 700 }}>
                    Couldn&apos;t load {lpPnl.errored} position{lpPnl.errored === 1 ? "" : "s"}
                    {lpPnl.errorReasons.length > 0 && <> — {lpPnl.errorReasons.slice(0, 3).join(", ")}</>}
                  </div>
                  <div style={{ fontSize: 12, color: `${C.red}99`, marginTop: 2 }}>
                    The RPC didn&apos;t respond in 30s. Totals shown are for the positions that did load.
                  </div>
                </div>
              )}
            </SectionFrame>

            {/* ── INCOME BY SOURCE + DAILY INCOME BY CHAIN ──────────────── */}
            <div className="ana-income-pair" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 20 }}>
              {/* Income by Source */}
              <div style={{ border: `1px solid ${C.border}`, background: C.bg1, padding: "22px 26px" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
                  <div style={{ fontSize: 11, letterSpacing: "0.2em", textTransform: "uppercase", color: C.textMid }}>
                    <span style={{ color: C.green }}>// </span>
                    Income by Source · {incomePeriod === "D" ? "Today" : incomePeriod === "M" ? "Month" : "Year"}
                  </div>
                  <div style={{ display: "flex" }}>
                    {(["D", "M", "Y"] as const).map((k) => {
                      const active = incomePeriod === k;
                      return (
                        <button
                          key={k}
                          type="button"
                          onClick={() => setIncomePeriod(k)}
                          style={{
                            fontFamily: FONT,
                            fontSize: 11,
                            padding: "4px 10px",
                            cursor: "pointer",
                            letterSpacing: "0.12em",
                            textTransform: "uppercase",
                            // Inline-only active state — border shorthand
                            // covers all 4 sides so no gap is possible.
                            border: active ? "1px solid #00ff41" : "none",
                            background: "transparent",
                            color: active ? "#00ff41" : C.text,
                          }}
                        >
                          {k}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {isLoading ? (
                  <div className="ana-income-source-inner" style={{ display: "flex", gap: 24, alignItems: "center" }}>
                    {/* Donut placeholder + legend skeleton */}
                    <Skel w={150} h={150} r={75} style={{ flexShrink: 0 }} />
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12 }}>
                      <Skel w="100%" h={16} />
                      <Skel w="100%" h={16} />
                      <Skel w="60%" h={14} />
                    </div>
                  </div>
                ) : incomeWindow.total > 0 ? (
                  <div className="ana-income-source-inner" style={{ display: "flex", gap: 24, alignItems: "center" }}>
                    <div style={{ width: 150, height: 150, flexShrink: 0, position: "relative" }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={[
                              ...(incomeWindow.lpAccrued > 0 ? [{ name: "LP Fees", value: incomeWindow.lpAccrued, color: C.green }] : []),
                              ...(incomeWindow.lendingProjected > 0 ? [{ name: "Lending", value: incomeWindow.lendingProjected, color: C.cyan }] : []),
                            ]}
                            cx="50%"
                            cy="50%"
                            outerRadius={70}
                            innerRadius={48}
                            dataKey="value"
                            paddingAngle={2}
                            stroke={C.bg}
                            strokeWidth={2}
                          >
                            {([
                              ...(incomeWindow.lpAccrued > 0 ? [{ color: C.green as string }] : []),
                              ...(incomeWindow.lendingProjected > 0 ? [{ color: C.cyan as string }] : []),
                            ]).map((c, i) => (
                              <Cell key={i} fill={c.color} />
                            ))}
                          </Pie>
                        </PieChart>
                      </ResponsiveContainer>
                      <div
                        style={{
                          position: "absolute", inset: 0,
                          display: "flex", flexDirection: "column",
                          alignItems: "center", justifyContent: "center",
                          pointerEvents: "none", textAlign: "center",
                        }}
                      >
                        <span style={{ fontSize: 16, fontWeight: 700, color: C.textBright, fontVariantNumeric: "tabular-nums" }}>
                          {fmt$(incomeWindow.total)}
                        </span>
                        <span style={{ fontSize: 10, color: C.text, letterSpacing: "0.18em", textTransform: "uppercase", marginTop: 2 }}>
                          {incomePeriod === "D" ? "Daily" : incomePeriod === "M" ? "Monthly" : "Yearly"}
                        </span>
                      </div>
                    </div>

                    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12 }}>
                      {[
                        { name: "LP Fees", val: incomeWindow.lpAccrued, color: C.green, pct: incomeWindow.total > 0 ? (incomeWindow.lpAccrued / incomeWindow.total) * 100 : 0 },
                        { name: "Lending Interest", val: incomeWindow.lendingProjected, color: C.cyan, pct: incomeWindow.total > 0 ? (incomeWindow.lendingProjected / incomeWindow.total) * 100 : 0 },
                      ].map((d) => (
                        <div key={d.name} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14.5 }}>
                          <span style={{ width: 7, height: 7, background: d.color, flexShrink: 0, boxShadow: `0 0 5px ${d.color}88` }} />
                          <span style={{ color: C.textMid, flex: 1, letterSpacing: "0.04em" }}>{d.name}</span>
                          <span style={{ fontWeight: 700, color: C.textBright, fontVariantNumeric: "tabular-nums" }}>{fmt$(d.val)}</span>
                          <span style={{ color: C.text, fontSize: 11, minWidth: 32, textAlign: "right" }}>{d.pct.toFixed(0)}%</span>
                        </div>
                      ))}
                      <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 10, marginTop: 2, display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                        <span style={{ color: C.text, letterSpacing: "0.18em", textTransform: "uppercase" }}>Total</span>
                        <span style={{ color: C.green, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{fmt$(incomeWindow.total)}</span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 200, color: C.text, fontSize: 14 }}>
                    No income in this period
                  </div>
                )}
              </div>

              {/* Daily Income by Chain */}
              <div style={{ border: `1px solid ${C.border}`, background: C.bg1, padding: "22px 26px" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
                  <div style={{ fontSize: 11, letterSpacing: "0.2em", textTransform: "uppercase", color: C.textMid }}>
                    <span style={{ color: C.green }}>// </span>
                    Income by Chain
                  </div>
                  <div style={{ display: "flex" }}>
                    {(["1D", "7D", "30D"] as const).map((k) => {
                      const active = chainPeriod === k;
                      return (
                        <button
                          key={k}
                          type="button"
                          onClick={() => setChainPeriod(k)}
                          style={{
                            fontFamily: FONT,
                            fontSize: 11,
                            padding: "4px 10px",
                            cursor: "pointer",
                            letterSpacing: "0.12em",
                            textTransform: "uppercase",
                            // Inline-only active state — border shorthand
                            // covers all 4 sides so no gap is possible.
                            border: active ? "1px solid #00ff41" : "none",
                            background: "transparent",
                            color: active ? "#00ff41" : C.text,
                          }}
                        >
                          {k}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {isLoading ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {Array.from({ length: 4 }).map((_, i) => (
                      <div key={`chain-skel-${i}`} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <Skel w={70} h={14} />
                        <div style={{ flex: 1 }}><Skel w="100%" h={10} /></div>
                        <Skel w={60} h={12} />
                      </div>
                    ))}
                  </div>
                ) : incomeByChain.length > 0 ? (
                  (() => {
                    const days = chainPeriod === "1D" ? 1 : chainPeriod === "7D" ? 7 : 30;
                    const rows = [...incomeByChain].map((c) => ({ chain: c.chain, period: c.daily * days, daily: c.daily })).sort((a, b) => b.period - a.period);
                    const max = Math.max(...rows.map((r) => r.period), 0.0001);
                    const totalDaily = incomeByChain.reduce((s, c) => s + c.daily, 0);
                    return (
                      <>
                        <div style={{ display: "flex", flexDirection: "column" }}>
                          {rows.map((row) => {
                            const pct = max > 0 ? (row.period / max) * 100 : 0;
                            const color = CHAIN_COLORS[row.chain] ?? C.green;
                            return (
                              <div
                                key={row.chain}
                                style={{
                                  display: "flex", alignItems: "center", gap: 14,
                                  padding: "11px 0",
                                  borderBottom: `1px solid ${C.border}`,
                                  fontSize: 14.5,
                                }}
                              >
                                <span style={{ width: 6, height: 6, background: color, flexShrink: 0, boxShadow: `0 0 4px ${color}88` }} />
                                <span style={{ color: C.textMid, minWidth: 70, letterSpacing: "0.04em" }}>{row.chain}</span>
                                <div style={{ flex: 1, height: 3, background: C.border, position: "relative" }}>
                                  <div
                                    style={{
                                      height: "100%",
                                      width: `${Math.max(pct, 2)}%`,
                                      background: color,
                                      boxShadow: `0 0 4px ${color}66`,
                                      transition: "width 1.2s ease",
                                    }}
                                  />
                                </div>
                                <span style={{ fontWeight: 700, color: C.textBright, minWidth: 64, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                                  {fmt$(row.period)}
                                </span>
                                <span className="ana-chain-mo" style={{ fontSize: 11, color: C.text, minWidth: 50, textAlign: "right" }}>
                                  {fmt$(row.daily * 30, 0)}/mo
                                </span>
                              </div>
                            );
                          })}
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 12, fontSize: 12, borderTop: `1px solid ${C.border}`, marginTop: 6 }}>
                          <span style={{ color: C.text, letterSpacing: "0.18em", textTransform: "uppercase", fontSize: 11 }}>
                            Total / mo
                          </span>
                          <span style={{ color: C.textBright, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                            {fmt$(totalDaily * 30)}
                          </span>
                        </div>
                      </>
                    );
                  })()
                ) : (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 200, color: C.text, fontSize: 14 }}>
                    No active LP positions
                  </div>
                )}
              </div>
            </div>

            {/* ── POSITION PERFORMANCE ──────────────────────────────────── */}
            <SectionFrame
              id="section-performance"
              title="Position Performance"
              sub="APR, fees collected, daily income and status per position"
            >
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: FONT }}>
                  <thead>
                    <tr style={{ background: C.bg2 }}>
                      <th
                        className="ana-col-position"
                        style={{
                          padding: "12px 16px 12px 26px",
                          fontSize: 11, fontWeight: 400, color: C.text,
                          letterSpacing: "0.18em", textTransform: "uppercase",
                          borderBottom: `1px solid ${C.border}`,
                          textAlign: "left",
                        }}
                      >
                        Position
                      </th>
                      <th
                        className="sort-th"
                        onClick={() => handleSort("protocol")}
                        style={{
                          padding: "12px 16px",
                          fontSize: 11, fontWeight: 400, color: C.text,
                          letterSpacing: "0.18em", textTransform: "uppercase",
                          borderBottom: `1px solid ${C.border}`,
                          textAlign: "left", cursor: "pointer",
                        }}
                      >
                        Protocol <SortIcon col="protocol" />
                      </th>
                      <th
                        className="sort-th"
                        onClick={() => handleSort("chain")}
                        style={{
                          padding: "12px 16px",
                          fontSize: 11, fontWeight: 400, color: C.text,
                          letterSpacing: "0.18em", textTransform: "uppercase",
                          borderBottom: `1px solid ${C.border}`,
                          textAlign: "left", cursor: "pointer",
                        }}
                      >
                        Chain <SortIcon col="chain" />
                      </th>
                      <th
                        className="sort-th ana-col-value"
                        onClick={() => handleSort("value")}
                        style={{
                          padding: "12px 16px",
                          fontSize: 11, fontWeight: 400, color: C.text,
                          letterSpacing: "0.18em", textTransform: "uppercase",
                          borderBottom: `1px solid ${C.border}`,
                          textAlign: "right", cursor: "pointer",
                        }}
                      >
                        Value <SortIcon col="value" />
                      </th>
                      <th
                        className="sort-th"
                        onClick={() => handleSort("apy")}
                        style={{
                          padding: "12px 16px",
                          fontSize: 11, fontWeight: 400, color: C.text,
                          letterSpacing: "0.18em", textTransform: "uppercase",
                          borderBottom: `1px solid ${C.border}`,
                          textAlign: "right", cursor: "pointer",
                        }}
                      >
                        APR <SortIcon col="apy" />
                      </th>
                      <th
                        className="sort-th ana-col-daily"
                        onClick={() => handleSort("daily")}
                        style={{
                          padding: "12px 16px",
                          fontSize: 11, fontWeight: 400, color: C.text,
                          letterSpacing: "0.18em", textTransform: "uppercase",
                          borderBottom: `1px solid ${C.border}`,
                          textAlign: "right", cursor: "pointer",
                        }}
                      >
                        Daily <SortIcon col="daily" />
                      </th>
                      <th
                        className="sort-th ana-col-fees"
                        onClick={() => handleSort("fees")}
                        style={{
                          padding: "12px 16px",
                          fontSize: 11, fontWeight: 400, color: C.text,
                          letterSpacing: "0.18em", textTransform: "uppercase",
                          borderBottom: `1px solid ${C.border}`,
                          textAlign: "right", cursor: "pointer",
                        }}
                      >
                        Fees <SortIcon col="fees" />
                      </th>
                      <th
                        className="ana-col-status"
                        style={{
                          padding: "12px 16px",
                          fontSize: 11, fontWeight: 400, color: C.text,
                          letterSpacing: "0.18em", textTransform: "uppercase",
                          borderBottom: `1px solid ${C.border}`,
                          textAlign: "center",
                        }}
                      >
                        Status
                      </th>
                      <th
                        className="ana-col-analyze"
                        style={{
                          padding: "12px 26px 12px 16px",
                          fontSize: 11, fontWeight: 400, color: C.text,
                          letterSpacing: "0.18em", textTransform: "uppercase",
                          borderBottom: `1px solid ${C.border}`,
                          textAlign: "right",
                        }}
                      />
                    </tr>
                  </thead>
                  <tbody>
                    {/* Skeleton rows while positions / activity loads.
                        Only shown when we have no real rows yet to avoid
                        flashing skeletons on top of real data. */}
                    {(isLoading || activityLoading) && sortedPositions.length === 0 && (
                      Array.from({ length: 4 }).map((_, i) => (
                        <tr key={`skel-${i}`} style={{ borderBottom: `1px solid ${C.border}` }}>
                          <td className="ana-col-position" style={{ padding: "12px 16px 12px 26px" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                              <Skel w={30} h={30} r={2} />
                              <Skel w={120} h={14} />
                            </div>
                          </td>
                          <td style={{ padding: "12px 16px" }}><Skel w={80} h={12} /></td>
                          <td style={{ padding: "12px 16px" }}><Skel w={60} h={12} /></td>
                          <td className="ana-col-value" style={{ padding: "13px 16px", textAlign: "right" }}><Skel w={70} h={14} style={{ marginLeft: "auto" }} /></td>
                          <td style={{ padding: "13px 16px", textAlign: "right" }}><Skel w={50} h={14} style={{ marginLeft: "auto" }} /></td>
                          <td className="ana-col-daily" style={{ padding: "13px 16px", textAlign: "right" }}><Skel w={50} h={14} style={{ marginLeft: "auto" }} /></td>
                          <td className="ana-col-fees" style={{ padding: "13px 16px", textAlign: "right" }}><Skel w={50} h={14} style={{ marginLeft: "auto" }} /></td>
                          <td className="ana-col-status" style={{ padding: "12px 16px", textAlign: "center" }}><Skel w={70} h={18} style={{ margin: "0 auto" }} /></td>
                          <td className="ana-col-analyze" style={{ padding: "12px 26px 12px 16px", textAlign: "right" }}><Skel w={60} h={22} style={{ marginLeft: "auto" }} /></td>
                        </tr>
                      ))
                    )}
                    {sortedPositions.map((p) => {
                      const protoColor = PROTOCOL_COLORS[p.protocol] ?? C.text;
                      const aprColor = p.displayAPR >= 20 ? C.green : p.displayAPR >= 5 ? C.amber : p.displayAPR > 0 ? C.red : C.text;
                      return (
                        <tr key={p.id} className="a-row" style={{ borderBottom: `1px solid ${C.border}` }}>
                          <td className="ana-col-position" style={{ padding: "12px 16px 12px 26px", verticalAlign: "middle" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                              <div
                                style={{
                                  width: 30, height: 30,
                                  border: `1px solid ${C.borderHi}`,
                                  background: C.bg2,
                                  display: "flex", alignItems: "center", justifyContent: "center",
                                  fontSize: 10, fontWeight: 700, color: C.textMid,
                                  letterSpacing: "0.04em",
                                  flexShrink: 0,
                                }}
                              >
                                {tokenInitials(p.pair)}
                              </div>
                              <div style={{ fontSize: 15.5, fontWeight: 700, color: C.textBright, letterSpacing: "0.02em" }}>{p.pair}</div>
                            </div>
                          </td>
                          <td style={{ padding: "12px 16px", verticalAlign: "middle" }}>
                            <span
                              style={{
                                fontSize: 11,
                                padding: "2px 8px",
                                background: `${protoColor}11`,
                                border: `1px solid ${protoColor}33`,
                                color: protoColor,
                                letterSpacing: "0.1em",
                                textTransform: "uppercase",
                                fontWeight: 700,
                              }}
                            >
                              {p.protocol}
                            </span>
                          </td>
                          <td style={{ padding: "12px 16px", verticalAlign: "middle" }}>
                            <ChainTag chain={p.chain} />
                          </td>
                          <td className="ana-col-value" style={{ padding: "13px 16px", textAlign: "right", fontSize: 15.5, fontWeight: 700, color: C.textBright, fontVariantNumeric: "tabular-nums" }}>
                            {fmt$(p.value)}
                          </td>
                          <td style={{ padding: "13px 16px", textAlign: "right", fontSize: 15.5, fontWeight: 700, color: aprColor, fontVariantNumeric: "tabular-nums" }}>
                            {p.displayAPR > 0 ? `${p.displayAPR.toFixed(1)}%` : "--"}
                            {p.isEstimated && p.displayAPR > 0 && (
                              <span style={{ fontSize: 10, color: C.text, marginLeft: 4 }}>est.</span>
                            )}
                          </td>
                          <td className="ana-col-daily" style={{ padding: "13px 16px", textAlign: "right", fontSize: 15.5, fontWeight: 700, color: C.textMid, fontVariantNumeric: "tabular-nums" }}>
                            {p.displayDaily > 0 ? fmt$(p.displayDaily) : "--"}
                          </td>
                          <td className="ana-col-fees" style={{ padding: "13px 16px", textAlign: "right", fontSize: 15.5, fontWeight: 700, color: C.cyan, fontVariantNumeric: "tabular-nums" }}>
                            {p.fees > 0 ? fmt$(p.fees) : "--"}
                          </td>
                          <td className="ana-col-status" style={{ padding: "12px 16px", textAlign: "center" }}>
                            <span
                              style={{
                                fontSize: 11,
                                padding: "2px 8px",
                                background:
                                  p.status === "In Range" ? `${C.green}15`
                                    : p.status === "Out of Range" ? `${C.amber}15`
                                    : `${C.text}15`,
                                border: `1px solid ${
                                  p.status === "In Range" ? `${C.green}55`
                                    : p.status === "Out of Range" ? `${C.amber}55`
                                    : `${C.text}55`
                                }`,
                                color:
                                  p.status === "In Range" ? C.green
                                    : p.status === "Out of Range" ? C.amber
                                    : C.text,
                                letterSpacing: "0.1em",
                                textTransform: "uppercase",
                                fontWeight: 700,
                              }}
                            >
                              {p.status}
                            </span>
                          </td>
                          <td className="ana-col-analyze" style={{ padding: "12px 26px 12px 16px", textAlign: "right" }}>
                            <Link
                              href={`/dashboard/position/${p.id}`}
                              className="analyze-btn"
                              style={{
                                fontFamily: FONT,
                                fontSize: 10,
                                fontWeight: 600,
                                letterSpacing: "0.14em",
                                textTransform: "uppercase",
                                padding: "6px 12px",
                                border: `1px solid ${C.borderHi}`,
                                background: "transparent",
                                color: C.text,
                                textDecoration: "none",
                                whiteSpace: "nowrap",
                                transition: "all 0.15s",
                                display: "inline-block",
                              }}
                            >
                              Analyze →
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                    {!isLoading && !activityLoading && sortedPositions.length === 0 && (
                      <tr>
                        <td colSpan={9} style={{ padding: 32, textAlign: "center", color: C.text, fontSize: 14 }}>
                          No active LP positions
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Lending positions summary rows */}
              {lendingPositions.length > 0 && (
                <div style={{ borderTop: `1px solid ${C.border}`, padding: "16px 26px" }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: C.text, letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 12 }}>
                    Lending Positions
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {lendingPositions.map((lp) => {
                      const color = PROTOCOL_COLORS[lp.protocol] ?? C.text;
                      return (
                        <div
                          key={lp.protocol + lp.chain}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            padding: "8px 12px",
                            background: C.bg2,
                            border: `1px solid ${C.border}`,
                            borderLeft: `3px solid ${color}`,
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                            <span style={{ fontSize: 12, fontWeight: 700, color, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                              {lp.protocol}
                            </span>
                            <ChainTag chain={lp.chain} />
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 18, fontSize: 14, fontFamily: FONT, fontVariantNumeric: "tabular-nums" }}>
                            <span style={{ color: C.textBright, fontWeight: 700 }}>{fmt$(lp.totalSupplied)}</span>
                            <span style={{ color: lp.supplyApy != null && lp.supplyApy > 0 ? C.green : C.text, fontWeight: 700 }}>
                              {lp.supplyApy != null ? `${lp.supplyApy.toFixed(1)}%` : "--"}
                            </span>
                            {lp.totalBorrowed > 0 && (
                              <span style={{ color: C.red, fontWeight: 700 }}>-{fmt$(lp.totalBorrowed)}</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </SectionFrame>

            {/* ── EARNING FLOWS (recent fee claims) ──────────────────────── */}
            {(activityLoading || feeIncome.recent.length > 0) && (
              <SectionFrame title="Earning Flows" sub="Recent on-chain fee claim events">
                <div style={{ display: "flex", flexDirection: "column" }}>
                  {/* Skeleton rows while activity loads and we have no
                      real fee-claim events yet. */}
                  {activityLoading && feeIncome.recent.length === 0 && (
                    Array.from({ length: 4 }).map((_, i) => (
                      <div
                        key={`flow-skel-${i}`}
                        className="ana-flow-row"
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 14,
                          padding: "12px 28px",
                          borderBottom: `1px solid ${C.border}`,
                        }}
                      >
                        <Skel w={6} h={6} r={0} />
                        <Skel w={100} h={11} />
                        <Skel w={60} h={18} />
                        <div style={{ flex: 1 }}><Skel w={80} h={10} /></div>
                        <Skel w={80} h={14} />
                        <Skel w={64} h={11} />
                      </div>
                    ))
                  )}
                  {feeIncome.recent.map((e, i) => {
                    const color = PROTOCOL_COLORS[e.protocol] ?? C.green;
                    const mins = Math.max(1, Math.floor((Date.now() - e.ts) / 60_000));
                    const timeStr = mins < 60 ? `${mins}m ago`
                      : mins < 60 * 24 ? `${Math.floor(mins / 60)}h ago`
                      : `${Math.floor(mins / (60 * 24))}d ago`;
                    return (
                      <div
                        key={`${e.dedupeKey}_${i}`}
                        className="a-row ana-flow-row"
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 14,
                          padding: "12px 28px",
                          borderBottom: `1px solid ${C.border}`,
                          fontSize: 14.5,
                        }}
                      >
                        <span style={{ width: 6, height: 6, background: color, flexShrink: 0, boxShadow: `0 0 5px ${color}88` }} />
                        <span style={{ minWidth: 100, color: C.textMid, fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 700 }}>
                          {e.protocol}
                        </span>
                        <ChainTag chain={e.chain} />
                        <span className="ana-flow-label" style={{ flex: 1, color: C.text, fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase" }}>
                          Fee Claim
                        </span>
                        <span className="ana-flow-amount" style={{ fontWeight: 700, color: C.green, minWidth: 80, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                          +{fmt$(e.usd)}
                        </span>
                        <span className="ana-flow-time" style={{ fontSize: 11, color: C.text, minWidth: 64, textAlign: "right", letterSpacing: "0.04em" }}>{timeStr}</span>
                      </div>
                    );
                  })}
                </div>
              </SectionFrame>
            )}

            {/* ── EXPOSURE — Chain + Protocol donuts ────────────────────── */}
            <div id="section-exposure" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 20 }}>
              <ExposureCard
                title="Chain Exposure"
                warning={chainWarning}
                data={chainExposure}
                colorOf={(name, i) => CHAIN_COLORS[name] ?? PIE_COLORS[i % PIE_COLORS.length]}
                centerPrimary={fmtCompact(totalPortfolioValue)}
                centerSecondary={`${chainExposure.length} chain${chainExposure.length === 1 ? "" : "s"}`}
                valueFmt={(v) => fmt$(v)}
              />
              <ExposureCard
                title="Protocol Exposure"
                warning={protocolWarning}
                data={protocolExposure}
                colorOf={(name, i) => PROTOCOL_COLORS[name] ?? PIE_COLORS[i % PIE_COLORS.length]}
                centerPrimary={String(protocolExposure.length)}
                centerSecondary="active"
                valueFmt={(v) => fmt$(v)}
              />
            </div>

            {/* ── PERFORMANCE RANKINGS ──────────────────────────────────── */}
            {(topPerformers.length > 0 || bottomPerformers.length > 0) && (
              <SectionFrame
                title="Performance Rankings"
                sub={`Ranked by actual APR from claimed fees${activityLoading ? " (loading…)" : ""}`}
              >
                <div className="ana-rankings-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
                  {/* Top */}
                  <div className="ana-rankings-top" style={{ padding: "22px 26px", borderRight: `1px solid ${C.border}` }}>
                    <div
                      style={{
                        fontSize: 11, letterSpacing: "0.2em", textTransform: "uppercase",
                        color: C.textMid, marginBottom: 16,
                      }}
                    >
                      <span style={{ color: C.green, marginRight: 6 }}>▲</span>
                      Top Performers
                    </div>
                    {topPerformers.map((p, i) => (
                      <div
                        key={p.id}
                        style={{
                          display: "flex", alignItems: "center", gap: 14,
                          padding: "10px 0",
                          borderBottom: i === topPerformers.length - 1 ? "none" : `1px solid ${C.border}`,
                        }}
                      >
                        <span style={{ fontSize: 12, fontWeight: 700, color: C.text, minWidth: 24, letterSpacing: "0.1em" }}>
                          #{i + 1}
                        </span>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 15.5, fontWeight: 700, color: C.textBright, letterSpacing: "0.02em" }}>
                            {p.pair}
                          </div>
                          <div style={{ fontSize: 14, color: C.text, marginTop: 3, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                            {p.protocol} · {p.chain}
                          </div>
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <div
                            style={{
                              fontSize: 17, fontWeight: 700, color: C.green,
                              fontVariantNumeric: "tabular-nums",
                              textShadow: "0 0 10px rgba(0,255,65,0.25)",
                            }}
                          >
                            {p.displayAPR.toFixed(1)}%
                            {p.isEstimated && <span style={{ fontSize: 10, color: C.text, marginLeft: 4, fontWeight: 400 }}>est.</span>}
                          </div>
                          <div style={{ fontSize: 11, color: C.text, marginTop: 3, letterSpacing: "0.04em" }}>{fmt$(p.value)}</div>
                        </div>
                      </div>
                    ))}
                    {topPerformers.length === 0 && (
                      <p style={{ color: C.text, fontSize: 14 }}>No active positions</p>
                    )}
                  </div>

                  {/* Bottom */}
                  <div style={{ padding: "22px 26px" }}>
                    <div
                      style={{
                        fontSize: 11, letterSpacing: "0.2em", textTransform: "uppercase",
                        color: C.textMid, marginBottom: 16,
                      }}
                    >
                      <span style={{ color: C.red, marginRight: 6 }}>▼</span>
                      Lowest Yield
                    </div>
                    {bottomPerformers.map((p, i) => (
                      <div
                        key={p.id}
                        style={{
                          display: "flex", alignItems: "center", gap: 14,
                          padding: "10px 0",
                          borderBottom: i === bottomPerformers.length - 1 ? "none" : `1px solid ${C.border}`,
                        }}
                      >
                        <span style={{ fontSize: 12, fontWeight: 700, color: C.text, minWidth: 24, letterSpacing: "0.1em" }}>
                          #{i + 1}
                        </span>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 15.5, fontWeight: 700, color: C.textBright, letterSpacing: "0.02em" }}>
                            {p.pair}
                          </div>
                          <div style={{ fontSize: 14, color: C.text, marginTop: 3, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                            {p.protocol} · {p.chain}
                          </div>
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <div
                            style={{
                              fontSize: 17, fontWeight: 700,
                              color: p.displayAPR < 5 ? C.red : C.amber,
                              fontVariantNumeric: "tabular-nums",
                            }}
                          >
                            {p.displayAPR.toFixed(1)}%
                            {p.isEstimated && <span style={{ fontSize: 10, color: C.text, marginLeft: 4, fontWeight: 400 }}>est.</span>}
                          </div>
                          <div style={{ fontSize: 11, color: C.text, marginTop: 3, letterSpacing: "0.04em" }}>{fmt$(p.value)}</div>
                        </div>
                      </div>
                    ))}
                    {bottomPerformers.length === 0 && (
                      <p style={{ color: C.text, fontSize: 14 }}>No active positions</p>
                    )}
                  </div>
                </div>
              </SectionFrame>
            )}

          </div>{/* /content */}
        </main>
      </div>{/* /layout */}
    </div>
  );
}
