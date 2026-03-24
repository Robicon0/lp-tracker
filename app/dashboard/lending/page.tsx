"use client";

import { useMemo, useState, useEffect, type CSSProperties } from "react";
import Link from "next/link";
import Navbar from "../../Navbar";
import { useAccount } from "wagmi";
import { useWalletAuth } from "../../contexts/WalletAuthContext";
import { useWalletTokens, type TokenItem } from "../../hooks/useWalletTokens";
import { getTokenLogo, TOKEN_COLORS } from "../../lib/tokenLogos";

// ── Helpers ────────────────────────────────────────────────────────────────────
function fmt$(n: number, dec = 2) {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;
}
function fmtBalance(n: number) {
  if (n >= 1_000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

// AAVE V3 manage URLs by chain
const AAVE_URL: Record<string, string> = {
  Base:      "https://app.aave.com/?marketName=proto_base_v3",
  Ethereum:  "https://app.aave.com/?marketName=proto_mainnet_v3",
  Arbitrum:  "https://app.aave.com/?marketName=proto_arbitrum_v3",
  Optimism:  "https://app.aave.com/?marketName=proto_optimism_v3",
  Polygon:   "https://app.aave.com/?marketName=proto_polygon_v3",
};

// Approximate AAVE V3 supply APYs (shown with disclaimer — users see exact rates on AAVE)
const AAVE_SUPPLY_APY: Record<string, number> = {
  USDC: 2.86, USDbC: 2.86, "USDC.e": 2.86,
  USDT: 3.50,
  DAI:  2.20,
  WETH: 1.80, ETH: 1.80,
  WBTC: 0.80, cbBTC: 0.80,
};

function getAaveSupplyApy(underlying: string): number {
  return AAVE_SUPPLY_APY[underlying] ?? 0;
}

// aToken → underlying symbol (duplicated from hook, used for display labels)
function getUnderlying(symbol: string): string {
  const rest = symbol.startsWith("a") ? symbol.slice(1) : symbol.slice(1);
  for (const prefix of ["Bas", "Arb", "Opt", "Eth", "Pol"]) {
    if (rest.startsWith(prefix)) return rest.slice(prefix.length);
  }
  return rest;
}

// Detect chain prefix from aToken symbol
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

// Inline token icon
function TokenIcon({ symbol, size = 28, logo, style }: {
  symbol: string; size?: number; logo?: string; style?: CSSProperties;
}) {
  const [err, setErr] = useState(false);
  const src = (!err && (logo || getTokenLogo(symbol))) || null;
  const color = TOKEN_COLORS[symbol] ?? TOKEN_COLORS[symbol.toUpperCase()] ?? "#6B7280";
  const base: CSSProperties = { width: size, height: size, borderRadius: "50%", flexShrink: 0, ...style };
  if (src) {
    return <img src={src} alt={symbol} onError={() => setErr(true)}
      style={{ ...base, objectFit: "cover", display: "block" }} />;
  }
  return (
    <div style={{ ...base, background: color,
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.38, fontWeight: 700, color: "white" }}>
      {symbol.charAt(0).toUpperCase()}
    </div>
  );
}

// ── LendingPosition = one AAVE card per chain ──────────────────────────────────
interface LendingPosition {
  chain: string;
  protocol: string;
  suppliedTokens: TokenItem[];
  debtTokens: TokenItem[];
  totalCollateral: number;
  totalDebt: number;
  netWorth: number;
  supplyApy: number; // weighted avg supply APY
  borrowApy: number;
  netApy: number;
  dailyCashflow: number;
  ltvPct: number;
  liquidationThreshold: number;
  availableToBorrow: number;
  healthFactor: number | null; // null = ∞
}

function buildPositions(tokens: TokenItem[]): LendingPosition[] {
  const lendingTokens = tokens.filter((t) => t.isLending);
  const debtTokens    = tokens.filter((t) => t.isDebt);

  // Group by detected chain
  const chainMap = new Map<string, TokenItem[]>();
  for (const t of lendingTokens) {
    const detectedChain = getATokenChain(t.symbol) ?? t.chain;
    const arr = chainMap.get(detectedChain) ?? [];
    arr.push(t);
    chainMap.set(detectedChain, arr);
  }

  return [...chainMap.entries()].map(([chain, supplied]) => {
    const chainDebt = debtTokens.filter((t) => t.chain === chain);
    const totalCollateral = supplied.reduce((s, t) => s + t.usdValue, 0);
    const totalDebt = chainDebt.reduce((s, t) => s + t.usdValue, 0);

    // Weighted avg supply APY
    const supplyApy = totalCollateral > 0
      ? supplied.reduce((s, t) => s + getAaveSupplyApy(getUnderlying(t.symbol)) * t.usdValue, 0) / totalCollateral
      : 0;

    const borrowApy = 0; // simplified: show 0 if no debt detected
    const netApy = supplyApy - borrowApy;
    const dailyCashflow = (totalCollateral * supplyApy) / 100 / 365;
    const ltvPct = totalCollateral > 0 ? (totalDebt / totalCollateral) * 100 : 0;
    const liquidationThreshold = 78; // Standard AAVE V3 USDC LT
    const availableToBorrow = Math.max(0, totalCollateral * liquidationThreshold / 100 - totalDebt);

    return {
      chain,
      protocol: "AAVE V3",
      suppliedTokens: supplied,
      debtTokens: chainDebt,
      totalCollateral,
      totalDebt,
      netWorth: totalCollateral - totalDebt,
      supplyApy,
      borrowApy,
      netApy,
      dailyCashflow,
      ltvPct,
      liquidationThreshold,
      availableToBorrow,
      healthFactor: totalDebt > 0 ? (totalCollateral * liquidationThreshold / 100) / totalDebt : null,
    };
  });
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function LendingPage() {
  const { address } = useAccount();
  const { solanaAddress, suiAddress } = useWalletAuth();
  const hasWallet = !!(address || solanaAddress || suiAddress);
  const { tokens, isLoading } = useWalletTokens();
  const [loadingTimeout, setLoadingTimeout] = useState(false);

  useEffect(() => {
    if (!isLoading) { setLoadingTimeout(false); return; }
    const t = setTimeout(() => setLoadingTimeout(true), 15000);
    return () => clearTimeout(t);
  }, [isLoading]);

  const positions = useMemo(() => buildPositions(tokens), [tokens]);

  const totalCollateral = positions.reduce((s, p) => s + p.totalCollateral, 0);
  const totalDebt       = positions.reduce((s, p) => s + p.totalDebt, 0);
  const netWorth        = totalCollateral - totalDebt;
  const netApy          = totalCollateral > 0
    ? positions.reduce((s, p) => s + p.supplyApy * p.totalCollateral, 0) / totalCollateral
    : 0;
  const dailyCashflow   = positions.reduce((s, p) => s + p.dailyCashflow, 0);

  return (
    <div style={{ background: "#060d08", minHeight: "100vh", color: "white" }}>
      <Navbar />
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "80px 24px 60px" }}>

        {/* Back + header */}
        <Link href="/dashboard" style={{ display: "inline-flex", alignItems: "center", gap: 6,
          fontSize: 13, color: "rgba(255,255,255,0.4)", textDecoration: "none", marginBottom: 24 }}>
          ← Back to Dashboard
        </Link>
        <h1 style={{ fontSize: 30, fontWeight: 700, margin: "0 0 6px" }}>Lending &amp; Borrowing Positions</h1>
        <p style={{ fontSize: 14, color: "rgba(255,255,255,0.4)", margin: "0 0 28px" }}>
          Track your lending and borrowing across DeFi protocols
        </p>

        {/* No wallet */}
        {!hasWallet && (
          <div style={{ textAlign: "center", padding: "60px 0" }}>
            <p style={{ fontSize: 16, color: "rgba(255,255,255,0.4)", marginBottom: 24 }}>
              Connect a wallet to see your lending positions.
            </p>
            <Link href="/dashboard" style={{ background: "rgba(16,185,129,0.2)",
              border: "1px solid rgba(16,185,129,0.3)", color: "#6ee7b7",
              borderRadius: 10, padding: "10px 20px", textDecoration: "none", fontSize: 14 }}>
              Go to Dashboard
            </Link>
          </div>
        )}

        {hasWallet && isLoading && positions.length === 0 && (
          <div style={{ textAlign: "center", padding: "60px 0", color: "rgba(255,255,255,0.3)" }}>
            <div style={{ width: 28, height: 28, border: "2px solid #10b981",
              borderTopColor: "transparent", borderRadius: "50%", margin: "0 auto 16px",
              animation: "spin 1s linear infinite" }} />
            <style>{`@keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }`}</style>
            Scanning wallet for lending positions…
            {loadingTimeout && (
              <p style={{ fontSize: 13, color: "#f59e0b", marginTop: 12 }}>
                Taking longer than expected. Token prices may be temporarily unavailable.
              </p>
            )}
          </div>
        )}

        {hasWallet && !isLoading && positions.length === 0 && (
          <div style={{ textAlign: "center", padding: "60px 0" }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>📭</div>
            <p style={{ fontSize: 16, color: "rgba(255,255,255,0.4)" }}>
              No lending positions detected.
            </p>
            <p style={{ fontSize: 13, color: "rgba(255,255,255,0.25)", marginTop: 8 }}>
              AAVE receipt tokens (aBasUSDC, aWETH, etc.) are automatically detected from your wallet.
            </p>
          </div>
        )}

        {hasWallet && positions.length > 0 && (
          <>
            {/* Summary Stats Row */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 28 }}
              className="lending-stats">
              {[
                {
                  label: "Net Worth",
                  value: fmt$(netWorth),
                  sub: "Collateral minus debt",
                  color: "#34d399",
                },
                {
                  label: "Total Supplied",
                  value: fmt$(totalCollateral),
                  sub: totalDebt > 0 ? `Borrowed: ${fmt$(totalDebt)}` : "No borrowing",
                  color: "#34d399",
                },
                {
                  label: "Net APY",
                  value: `${netApy.toFixed(2)}%`,
                  sub: "Weighted average",
                  color: "#6ee7b7",
                },
                {
                  label: "Est. Daily Yield",
                  value: `+${fmt$(dailyCashflow, 4)}`,
                  sub: `+${fmt$(dailyCashflow * 30)}/mo · +${fmt$(dailyCashflow * 365)}/yr`,
                  color: "#34d399",
                },
              ].map(({ label, value, sub, color }) => (
                <div key={label} style={{ background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.06)", borderRadius: 14, padding: 18 }}>
                  <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1,
                    color: "rgba(255,255,255,0.35)", margin: "0 0 8px" }}>{label}</p>
                  <p style={{ fontSize: 22, fontWeight: 700, color, margin: "0 0 4px",
                    letterSpacing: -0.5 }}>{value}</p>
                  <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", margin: 0 }}>{sub}</p>
                </div>
              ))}
            </div>

            {/* Position cards */}
            {positions.map((pos) => (
              <PositionCard key={pos.chain} pos={pos} />
            ))}

            {/* Footer notes */}
            <div style={{ marginTop: 32, padding: "16px 20px",
              background: "rgba(255,255,255,0.02)", borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.05)" }}>
              <p style={{ fontSize: 12, color: "rgba(255,255,255,0.3)", margin: "0 0 4px" }}>
                ⚠ Health Factor below 1.0 means your position can be liquidated.
              </p>
              <p style={{ fontSize: 12, color: "rgba(255,255,255,0.3)", margin: "0 0 4px" }}>
                📊 APY values are approximate. Real-time rates are available on AAVE.
              </p>
              <p style={{ fontSize: 12, color: "rgba(255,255,255,0.3)", margin: 0 }}>
                Net Worth = Total Collateral − Total Borrowed
              </p>
            </div>
          </>
        )}

        <style>{`
          @media (max-width: 640px) {
            .lending-stats { grid-template-columns: 1fr 1fr !important; }
          }
        `}</style>
      </div>
    </div>
  );
}

// ── Position Card ──────────────────────────────────────────────────────────────
function PositionCard({ pos }: { pos: LendingPosition }) {
  const fmt$ = (n: number, dec = 2) =>
    `$${n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;

  const hfDisplay = pos.healthFactor === null ? "∞"
    : pos.healthFactor.toFixed(2);
  const hfColor = pos.healthFactor === null ? "#34d399"
    : pos.healthFactor > 2 ? "#34d399"
    : pos.healthFactor > 1 ? "#f59e0b"
    : "#ef4444";

  const manageUrl = AAVE_URL[pos.chain] ?? AAVE_URL.Ethereum;

  const statBox = (label: string, value: string, color = "white", bg = "rgba(255,255,255,0.03)") => (
    <div style={{ background: bg, border: "1px solid rgba(255,255,255,0.06)",
      borderRadius: 10, padding: "14px 16px", textAlign: "center" }}>
      <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1,
        color: "rgba(255,255,255,0.35)", margin: "0 0 6px" }}>{label}</p>
      <p style={{ fontSize: 18, fontWeight: 700, color, margin: 0 }}>{value}</p>
    </div>
  );

  return (
    <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)",
      borderRadius: 16, overflow: "hidden", marginBottom: 24 }}>

      {/* Card header */}
      <div style={{ padding: "16px 20px", borderBottom: "1px solid rgba(255,255,255,0.06)",
        display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: "50%",
            background: "linear-gradient(135deg, #8b5cf6, #6d28d9)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 14, fontWeight: 700, color: "white" }}>A</div>
          <div>
            <p style={{ fontSize: 15, fontWeight: 700, color: "white", margin: 0 }}>
              {pos.protocol} · {pos.chain}
            </p>
            <div style={{ display: "flex", gap: 8, marginTop: 3 }}>
              <span style={{ background: "rgba(52,211,153,0.1)", border: "1px solid rgba(52,211,153,0.2)",
                color: "#34d399", fontSize: 11, padding: "2px 8px", borderRadius: 20 }}>
                Lending &amp; Borrowing
              </span>
            </div>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <p style={{ fontSize: 20, fontWeight: 700, color: "#34d399", margin: 0 }}>
            {fmt$(pos.totalCollateral)}
          </p>
          <p style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", margin: 0 }}>Total supplied</p>
        </div>
      </div>

      {/* Stats grid */}
      <div style={{ padding: "16px 20px" }}>

        {/* Row 1: Health + Collateral + Borrowed + Available */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 10 }}
          className="pos-4col">
          {statBox("Health Factor", hfDisplay, hfColor)}
          {statBox("Total Collateral", fmt$(pos.totalCollateral), "#34d399")}
          {statBox("Total Borrowed", fmt$(pos.totalDebt), pos.totalDebt > 0 ? "#ef4444" : "rgba(255,255,255,0.4)")}
          {statBox("Available to Borrow", fmt$(pos.availableToBorrow), "#60a5fa")}
        </div>

        {/* Row 2: LTV + Liquidation threshold */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}
          className="pos-2col">
          {statBox("Current LTV", `${pos.ltvPct.toFixed(2)}%`)}
          {statBox("Liquidation Threshold", `${pos.liquidationThreshold.toFixed(2)}%`, "#f59e0b")}
        </div>

        {/* Row 3: APY */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 10 }}
          className="pos-3col">
          {statBox("Lending APY", `${pos.supplyApy.toFixed(2)}%`, "#34d399",  "rgba(52,211,153,0.05)")}
          {statBox("Borrowing APY", `${pos.borrowApy.toFixed(2)}%`,
            pos.borrowApy > 0 ? "#ef4444" : "rgba(255,255,255,0.3)", "rgba(52,211,153,0.05)")}
          {statBox("Net APY", `${pos.netApy.toFixed(2)}%`, "#6ee7b7", "rgba(52,211,153,0.05)")}
        </div>

        {/* Row 4: Cashflow */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 16 }}
          className="pos-3col">
          {statBox("Daily Cashflow", `+${fmt$(pos.dailyCashflow, 4)}`, "#34d399", "rgba(52,211,153,0.05)")}
          {statBox("Monthly Cashflow", `+${fmt$(pos.dailyCashflow * 30)}`, "#34d399", "rgba(52,211,153,0.05)")}
          {statBox("Yearly Cashflow", `+${fmt$(pos.dailyCashflow * 365)}`, "#34d399", "rgba(52,211,153,0.05)")}
        </div>

        {/* Supplied Assets */}
        {pos.suppliedTokens.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <p style={{ fontSize: 12, color: "#34d399", fontWeight: 600,
              margin: "0 0 10px", textTransform: "uppercase", letterSpacing: 0.5 }}>
              ↑ Supplied Assets
            </p>
            {pos.suppliedTokens.map((t) => {
              const underlying = getUnderlying(t.symbol);
              const apy = getAaveSupplyApy(underlying);
              return (
                <div key={t.contractAddress}
                  style={{ display: "flex", alignItems: "center", gap: 12,
                    padding: "10px 14px", borderRadius: 10,
                    background: "rgba(52,211,153,0.04)",
                    border: "1px solid rgba(52,211,153,0.1)", marginBottom: 6 }}>
                  <TokenIcon symbol={underlying || t.symbol} size={32} logo={t.logo} />
                  <div style={{ flex: 1 }}>
                    <p style={{ fontSize: 14, fontWeight: 600, color: "white", margin: 0 }}>{underlying || t.symbol}</p>
                    <p style={{ fontSize: 11, color: "#34d399", margin: 0 }}>
                      APY: ~{apy.toFixed(2)}%
                      <span style={{ color: "rgba(255,255,255,0.25)", marginLeft: 6, fontSize: 10 }}>approx.</span>
                    </p>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <p style={{ fontSize: 14, fontWeight: 600, color: "white", margin: 0 }}>
                      {t.usdValue > 0 ? fmt$(t.usdValue) : "—"}
                    </p>
                    <p style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", margin: 0 }}>
                      {fmtBalance(t.balance)} {t.symbol}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Debt tokens (if any) */}
        {pos.debtTokens.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <p style={{ fontSize: 12, color: "#ef4444", fontWeight: 600,
              margin: "0 0 10px", textTransform: "uppercase", letterSpacing: 0.5 }}>
              ↓ Borrowed Assets
            </p>
            {pos.debtTokens.map((t) => (
              <div key={t.contractAddress}
                style={{ display: "flex", alignItems: "center", gap: 12,
                  padding: "10px 14px", borderRadius: 10,
                  background: "rgba(239,68,68,0.04)",
                  border: "1px solid rgba(239,68,68,0.15)", marginBottom: 6 }}>
                <TokenIcon symbol={t.symbol} size={32} logo={t.logo} />
                <div style={{ flex: 1 }}>
                  <p style={{ fontSize: 14, fontWeight: 600, color: "white", margin: 0 }}>{t.symbol}</p>
                  <p style={{ fontSize: 11, color: "#ef4444", margin: 0 }}>Borrowed</p>
                </div>
                <div style={{ textAlign: "right" }}>
                  <p style={{ fontSize: 14, fontWeight: 600, color: "#ef4444", margin: 0 }}>
                    {t.usdValue > 0 ? fmt$(t.usdValue) : "—"}
                  </p>
                  <p style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", margin: 0 }}>
                    {fmtBalance(t.balance)} tokens
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Manage button */}
        <a href={manageUrl} target="_blank" rel="noopener noreferrer"
          style={{ display: "block", width: "100%", textAlign: "center",
            background: "rgba(16,185,129,0.2)", border: "1px solid rgba(16,185,129,0.35)",
            color: "#6ee7b7", borderRadius: 10, padding: "12px",
            textDecoration: "none", fontSize: 14, fontWeight: 600, boxSizing: "border-box" }}>
          Manage on AAVE ↗
        </a>
      </div>
    </div>
  );
}
