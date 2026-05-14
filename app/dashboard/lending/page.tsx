"use client";

import { useMemo, useState, useEffect, type CSSProperties } from "react";
import Link from "next/link";
import TerminalNav from "../../components/TerminalNav";
import AnimatedCount from "../../components/AnimatedCount";
import { useAccount } from "wagmi";
import { useWalletAuth } from "../../contexts/WalletAuthContext";
import { useWalletTokens, type TokenItem } from "../../hooks/useWalletTokens";
import { useLendingPositions, type ExternalLendingPosition } from "../../hooks/useLendingPositions";
import { useAaveV3Rates, type AaveV3RatesMap } from "../../hooks/useAaveV3Rates";
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

const AAVE_URL: Record<string, string> = {
  Base:     "https://app.aave.com/?marketName=proto_base_v3",
  Ethereum: "https://app.aave.com/?marketName=proto_mainnet_v3",
  Arbitrum: "https://app.aave.com/?marketName=proto_arbitrum_v3",
  Optimism: "https://app.aave.com/?marketName=proto_optimism_v3",
  Polygon:  "https://app.aave.com/?marketName=proto_polygon_v3",
};

const FALLBACK_AAVE_SUPPLY_APY: Record<string, number> = {
  USDC: 2.86, USDbC: 2.86, "USDC.e": 2.86,
  USDT: 3.50, DAI: 2.20, WETH: 1.80, ETH: 1.80,
  WBTC: 0.80, cbBTC: 0.80,
};
function getFallbackSupplyApy(s: string): number {
  return FALLBACK_AAVE_SUPPLY_APY[s] ?? 0;
}

// ── Token icon ────────────────────────────────────────────────────────────────
function TokenIcon({
  symbol,
  size = 26,
  logo,
}: {
  symbol: string;
  size?: number;
  logo?: string;
}) {
  const [err, setErr] = useState(false);
  const src = (!err && (logo || getTokenLogo(symbol))) || null;
  const color = TOKEN_COLORS[symbol] ?? TOKEN_COLORS[symbol.toUpperCase()] ?? "#262626";
  const base: CSSProperties = {
    width: size,
    height: size,
    flexShrink: 0,
    border: "1px solid #262626",
  };
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={src}
        alt={symbol}
        onError={() => setErr(true)}
        style={{ ...base, objectFit: "cover", display: "block" }}
      />
    );
  }
  return (
    <div
      style={{
        ...base,
        background: color,
        color: "#fff",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size * 0.36,
        fontWeight: 700,
      }}
    >
      {symbol.charAt(0).toUpperCase()}
    </div>
  );
}

// ── AAVE LendingPosition (built from useWalletTokens) ──────────────────────────
interface LendingPosition {
  chain: string;
  protocol: string;
  suppliedTokens: TokenItem[];
  debtTokens: TokenItem[];
  totalCollateral: number;
  totalDebt: number;
  netWorth: number;
  supplyApy: number;
  borrowApy: number;
  netApy: number;
  dailyCashflow: number;
}

function rateForToken(t: TokenItem, liveRates: AaveV3RatesMap) {
  const live = liveRates[t.contractAddress?.toLowerCase() ?? ""];
  if (live) return live;
  return { supplyApy: getFallbackSupplyApy(t.symbol), borrowApy: 0 };
}

function buildPositions(tokens: TokenItem[], liveRates: AaveV3RatesMap): LendingPosition[] {
  const lend = tokens.filter((t) => t.isLending);
  const debt = tokens.filter((t) => t.isDebt);
  const chainMap = new Map<string, TokenItem[]>();
  for (const t of lend) {
    const arr = chainMap.get(t.chain) ?? [];
    arr.push(t);
    chainMap.set(t.chain, arr);
  }
  return [...chainMap.entries()].map(([chain, supplied]) => {
    const chainDebt = debt.filter((t) => t.chain === chain);
    const totalCollateral = supplied.reduce((s, t) => s + t.usdValue, 0);
    const totalDebt = chainDebt.reduce((s, t) => s + t.usdValue, 0);
    const supplyApy = totalCollateral > 0
      ? supplied.reduce((s, t) => s + rateForToken(t, liveRates).supplyApy * t.usdValue, 0) / totalCollateral
      : 0;
    const borrowApy = totalDebt > 0
      ? chainDebt.reduce((s, t) => s + rateForToken(t, liveRates).borrowApy * t.usdValue, 0) / totalDebt
      : 0;
    const netApy = supplyApy - borrowApy;
    const dailyCashflow = (totalCollateral * supplyApy) / 100 / 365 - (totalDebt * borrowApy) / 100 / 365;
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
    };
  });
}

const PAGE_BG = "#050505";
const SCANLINE =
  "repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(0,0,0,0.012) 3px, rgba(0,0,0,0.012) 4px)";

// ── Page ──────────────────────────────────────────────────────────────────────
export default function LendingPage() {
  const { address } = useAccount();
  const { solanaAddress, suiAddress } = useWalletAuth();
  const hasWallet = !!(address || solanaAddress || suiAddress);
  const { tokens: rawTokens, isLoading } = useWalletTokens();
  const { positions: externalPositions, isLoading: externalLoading } = useLendingPositions();
  const { rates: aaveRates, prices: aavePrices } = useAaveV3Rates(rawTokens);

  const tokens: TokenItem[] = useMemo(() => {
    return rawTokens.map((t) => {
      if ((!t.isLending && !t.isDebt) || t.price > 0) return t;
      const live = aavePrices[t.contractAddress?.toLowerCase() ?? ""];
      if (!live || live <= 0) return t;
      return { ...t, price: live, usdValue: t.balance * live };
    });
  }, [rawTokens, aavePrices]);

  const [loadingTimeout, setLoadingTimeout] = useState(false);
  const combinedLoading = isLoading || externalLoading;

  useEffect(() => {
    if (!combinedLoading) {
      setLoadingTimeout(false);
      return;
    }
    const t = setTimeout(() => setLoadingTimeout(true), 15000);
    return () => clearTimeout(t);
  }, [combinedLoading]);

  const positions = useMemo(() => buildPositions(tokens, aaveRates), [tokens, aaveRates]);

  const totalCollateral =
    positions.reduce((s, p) => s + p.totalCollateral, 0) +
    externalPositions.reduce((s, p) => s + p.totalSupplied, 0);
  const totalDebt =
    positions.reduce((s, p) => s + p.totalDebt, 0) +
    externalPositions.reduce((s, p) => s + p.totalBorrowed, 0);
  const netWorth = totalCollateral - totalDebt;
  const netApy =
    totalCollateral > 0
      ? (positions.reduce((s, p) => s + p.supplyApy * p.totalCollateral, 0) +
          externalPositions.reduce((s, p) => s + (p.supplyApy ?? 0) * p.totalSupplied, 0)) /
        totalCollateral
      : 0;
  const dailyCashflow =
    positions.reduce((s, p) => s + p.dailyCashflow, 0) +
    externalPositions.reduce(
      (s, p) => s + (p.totalSupplied * (p.supplyApy ?? 0)) / 100 / 365,
      0,
    );

  const hasAnyPositions = positions.length > 0 || externalPositions.length > 0;

  return (
    <div
      className="min-h-screen"
      style={{
        background: PAGE_BG,
        color: "#a0a0a0",
        fontFamily: "var(--font-jetbrains-mono)",
        fontSize: 15,
        lineHeight: 1.5,
      }}
    >
      <style
        dangerouslySetInnerHTML={{
          __html:
            '@keyframes lend-fade-up { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: translateY(0) } }',
        }}
      />
      <div
        aria-hidden
        className="fixed inset-0 pointer-events-none z-[9998]"
        style={{ background: SCANLINE }}
      />
      <TerminalNav active="dashboard" />

      <div
        className="px-4 sm:px-10 py-8"
        style={{ animation: "lend-fade-up 0.4s ease both", maxWidth: 1280, margin: "0 auto" }}
      >
        {/* Back link */}
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-2 mb-5 text-[#a0a0a0] hover:text-[#00ff41] transition-colors no-underline"
          style={{ fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase" }}
        >
          ← Back to Dashboard
        </Link>

        {/* Eyebrow + title */}
        <div
          className="mb-1.5"
          style={{
            fontSize: 11,
            letterSpacing: "0.22em",
            textTransform: "uppercase",
            color: "#a0a0a0",
            opacity: 0.6,
          }}
        >
          <span className="text-[#00ff41]" style={{ opacity: 1 }}>// lending</span> · borrowing positions across protocols
        </div>
        <h1
          className="font-bold mb-1.5"
          style={{ fontSize: 32, color: "#f0f0f0", letterSpacing: "-0.02em" }}
        >
          Lending &amp; Borrowing Positions
        </h1>
        <p className="mb-6" style={{ fontSize: 14, color: "#a0a0a0", opacity: 0.6 }}>
          Track your lending and borrowing across DeFi protocols
        </p>

        {/* Empty / loading states */}
        {!hasWallet && (
          <div className="text-center py-16">
            <p style={{ fontSize: 15, color: "#a0a0a0", marginBottom: 20 }}>
              Connect a wallet to see your lending positions.
            </p>
            <Link
              href="/dashboard"
              className="inline-block border border-[#00992a] text-[#00ff41] px-5 py-2.5 no-underline hover:bg-[rgba(0,255,65,0.08)] transition-colors"
              style={{
                fontSize: 14,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                background: "rgba(0,255,65,0.06)",
              }}
            >
              ▸ Go to Dashboard
            </Link>
          </div>
        )}

        {hasWallet && combinedLoading && !hasAnyPositions && (
          <div className="text-center py-16" style={{ color: "#a0a0a0" }}>
            <div
              className="mx-auto mb-4"
              style={{
                width: 24,
                height: 24,
                border: "2px solid #00ff41",
                borderTopColor: "transparent",
                animation: "spin 1s linear infinite",
              }}
            />
            <style>{"@keyframes spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }"}</style>
            <span style={{ fontSize: 14, letterSpacing: "0.1em", textTransform: "uppercase" }}>
              Scanning wallet for lending positions…
            </span>
            {loadingTimeout && (
              <p
                style={{ fontSize: 14, color: "#ffaa00", marginTop: 12, letterSpacing: "0.04em" }}
              >
                Taking longer than expected. Token prices may be temporarily unavailable.
              </p>
            )}
          </div>
        )}

        {hasWallet && !combinedLoading && !hasAnyPositions && (
          <div className="text-center py-16">
            <p style={{ fontSize: 16, color: "#a0a0a0" }}>
              No lending positions detected.
            </p>
            <p style={{ fontSize: 12, color: "#444", marginTop: 6, letterSpacing: "0.05em" }}>
              Supported: AAVE V3 (EVM), Dolomite, Jupiter Lend, Kamino, Suilend, AlphaFi, HyperLend, HypurrFi.
            </p>
          </div>
        )}

        {hasWallet && hasAnyPositions && (
          <>
            {/* Top stats */}
            <TopStats
              netWorth={netWorth}
              totalSupplied={totalCollateral}
              totalDebt={totalDebt}
              netApy={netApy}
              dailyCashflow={dailyCashflow}
            />

            {/* AAVE positions */}
            {positions.map((pos) => (
              <ProtocolCard key={`aave-${pos.chain}`} pos={pos} liveRates={aaveRates} />
            ))}

            {/* External lending positions */}
            {externalPositions.map((pos) => (
              <ExternalProtocolCard key={`${pos.protocol}-${pos.chain}`} pos={pos} />
            ))}

            {/* Footer notes */}
            <div
              className="mt-6 px-5 py-4 border border-[#1c1c1c]"
              style={{ background: "#090909", lineHeight: 1.8, color: "#a0a0a0", opacity: 0.75 }}
            >
              {[
                ["⚠", "Health Factor below 1.0 means your position can be liquidated."],
                ["▸", "APY values are approximate. Real-time rates are available on each protocol."],
                ["▸", "Net Worth = Total Collateral − Total Borrowed"],
                [
                  "▸",
                  "Jupiter Lend requires a free API key at portal.jup.ag — set JUPITER_API_KEY in .env.local to enable.",
                ],
              ].map(([mark, text], i) => (
                <div key={i} className="flex gap-2 items-start" style={{ fontSize: 12 }}>
                  <span style={{ color: "#ffaa00", flexShrink: 0 }}>{mark}</span>
                  <span>{text}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Top stats row ────────────────────────────────────────────────────────────
function TopStats({
  netWorth,
  totalSupplied,
  totalDebt,
  netApy,
  dailyCashflow,
}: {
  netWorth: number;
  totalSupplied: number;
  totalDebt: number;
  netApy: number;
  dailyCashflow: number;
}) {
  const stats: { label: string; value: React.ReactNode; sub: string }[] = [
    {
      label: "Net Worth",
      value: <AnimatedCount target={netWorth} prefix="$" decimals={2} />,
      sub: "Collateral minus debt",
    },
    {
      label: "Total Supplied",
      value: <AnimatedCount target={totalSupplied} prefix="$" decimals={2} />,
      sub: totalDebt > 0 ? `Borrowed: ${fmt$(totalDebt)}` : "No borrowing",
    },
    {
      label: "Net APY",
      value: <AnimatedCount target={netApy} suffix="%" decimals={2} />,
      sub: "Weighted average",
    },
    {
      label: "Est. Daily Yield",
      value: <AnimatedCount target={dailyCashflow} prefix="+$" decimals={4} />,
      sub: `+${fmt$(dailyCashflow * 30)}/mo · +${fmt$(dailyCashflow * 365)}/yr`,
    },
  ];
  return (
    <div
      className="grid grid-cols-2 md:grid-cols-4 mb-8 border border-[#1c1c1c]"
      style={{ background: "#090909" }}
    >
      {stats.map((s, i) => (
        <div
          key={s.label}
          className={`p-5 relative ${i < stats.length - 1 ? "md:border-r border-[#1c1c1c]" : ""} ${i % 2 === 0 ? "border-r border-[#1c1c1c] md:border-r" : ""} ${i < 2 ? "border-b md:border-b-0 border-[#1c1c1c]" : ""}`}
        >
          <div
            className="absolute top-0 left-0 right-0 h-px"
            style={{
              background:
                "linear-gradient(90deg, transparent, #262626, transparent)",
            }}
          />
          <div
            className="mb-2.5"
            style={{
              fontSize: 10,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: "#a0a0a0",
              opacity: 0.6,
            }}
          >
            {s.label}
          </div>
          <div
            className="font-bold tabular-nums"
            style={{
              fontSize: 30,
              letterSpacing: "-0.02em",
              color: "#00ff41",
              textShadow: "0 0 22px rgba(0,255,65,0.22)",
            }}
          >
            {s.value}
          </div>
          <div className="mt-1.5" style={{ fontSize: 11, color: "#a0a0a0", opacity: 0.5 }}>
            {s.sub}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Shared metric grid cell ───────────────────────────────────────────────────
function MetricCell({
  label,
  value,
  tone = "bright",
}: {
  label: string;
  value: string;
  tone?: "bright" | "green" | "dim" | "zero" | "red";
}) {
  const colorMap: Record<string, string> = {
    bright: "#e0e0e0",
    green: "#00ff41",
    dim: "#aaaaaa",
    zero: "rgba(122,122,122,0.6)",
    red: "#ff3355",
  };
  return (
    <div className="px-5 py-4 border-r border-b border-[#1c1c1c]">
      <div
        className="mb-1.5"
        style={{
          fontSize: 10,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "#a0a0a0",
          opacity: 0.55,
        }}
      >
        {label}
      </div>
      <div
        className="font-bold tabular-nums"
        style={{ fontSize: 20, letterSpacing: "-0.01em", color: colorMap[tone] }}
      >
        {value}
      </div>
    </div>
  );
}

// ── Protocol card (AAVE) ─────────────────────────────────────────────────────
function ProtocolCard({ pos, liveRates }: { pos: LendingPosition; liveRates: AaveV3RatesMap }) {
  const manageUrl = AAVE_URL[pos.chain] ?? AAVE_URL.Ethereum;
  return (
    <div
      className="border border-[#1c1c1c] mb-6"
      style={{ background: "#090909", animation: "lend-fade-up 0.5s ease both" }}
    >
      <CardHeader
        sym="A"
        name={`${pos.protocol} · ${pos.chain}`}
        rightValue={fmt$(pos.totalCollateral)}
        rightLabel="Total Supplied"
      />
      <MetricGrid
        cells={[
          { label: "Total Supplied", value: fmt$(pos.totalCollateral), tone: "bright" },
          { label: "Total Borrowed", value: fmt$(pos.totalDebt), tone: pos.totalDebt > 0 ? "red" : "zero" },
          { label: "Net Worth", value: fmt$(pos.netWorth), tone: "green" },
          { label: "Lending APY", value: `${pos.supplyApy.toFixed(2)}%`, tone: pos.supplyApy > 0 ? "green" : "zero" },
          { label: "Borrowing APY", value: `${pos.borrowApy.toFixed(2)}%`, tone: pos.borrowApy > 0 ? "red" : "zero" },
          { label: "Net APY", value: `${pos.netApy.toFixed(2)}%`, tone: pos.netApy > 0 ? "green" : "zero" },
          { label: "Daily Cashflow", value: `+${fmt$(pos.dailyCashflow, 4)}`, tone: pos.dailyCashflow > 0 ? "green" : "zero" },
          { label: "Monthly Cashflow", value: `+${fmt$(pos.dailyCashflow * 30)}`, tone: pos.dailyCashflow > 0 ? "green" : "zero" },
          { label: "Yearly Cashflow", value: `+${fmt$(pos.dailyCashflow * 365)}`, tone: pos.dailyCashflow > 0 ? "green" : "zero" },
        ]}
      />
      {pos.suppliedTokens.length > 0 && (
        <AssetsBlock label="↑ Supplied Assets">
          {pos.suppliedTokens.map((t) => {
            const live = liveRates[t.contractAddress?.toLowerCase() ?? ""];
            const apy = live?.supplyApy ?? getFallbackSupplyApy(t.symbol);
            return (
              <AssetRow
                key={t.contractAddress}
                symbol={t.symbol}
                logo={t.logo}
                apyLabel={`APY: ${apy.toFixed(2)}%`}
                value={t.usdValue > 0 ? fmt$(t.usdValue) : "—"}
                amount={`${fmtBalance(t.balance)} ${t.symbol}`}
              />
            );
          })}
        </AssetsBlock>
      )}
      {pos.debtTokens.length > 0 && (
        <AssetsBlock label="↓ Borrowed Assets" tone="red">
          {pos.debtTokens.map((t) => {
            const live = liveRates[t.contractAddress?.toLowerCase() ?? ""];
            const borrowApy = live?.borrowApy;
            return (
              <AssetRow
                key={t.contractAddress}
                symbol={t.symbol}
                logo={t.logo}
                apyLabel={
                  borrowApy !== undefined ? `Borrow APY: ${borrowApy.toFixed(2)}%` : "Borrowed"
                }
                apyTone="red"
                value={t.usdValue > 0 ? fmt$(t.usdValue) : "—"}
                valueTone="red"
                amount={`${fmtBalance(t.balance)} ${t.symbol}`}
              />
            );
          })}
        </AssetsBlock>
      )}
      <ManageButton href={manageUrl} label="AAVE" />
    </div>
  );
}

// ── External protocol card (Dolomite, Jupiter Lend, Kamino, Suilend, etc.) ────
function ExternalProtocolCard({ pos }: { pos: ExternalLendingPosition }) {
  const dailyCashflow =
    (pos.totalSupplied * (pos.supplyApy ?? 0)) / 100 / 365 -
    (pos.totalBorrowed * pos.borrowApy) / 100 / 365;
  const hasApy = pos.supplyApy !== null;
  const netWorth = pos.totalSupplied - pos.totalBorrowed;
  const netApy = hasApy ? pos.supplyApy! - pos.borrowApy : 0;
  return (
    <div
      className="border border-[#1c1c1c] mb-6"
      style={{ background: "#090909", animation: "lend-fade-up 0.5s ease both" }}
    >
      <CardHeader
        sym={pos.protocol.charAt(0)}
        name={`${pos.protocol} · ${pos.chain}`}
        rightValue={fmt$(pos.totalSupplied)}
        rightLabel="Total Supplied"
      />
      <MetricGrid
        cells={[
          { label: "Total Supplied", value: fmt$(pos.totalSupplied), tone: "bright" },
          { label: "Total Borrowed", value: fmt$(pos.totalBorrowed), tone: pos.totalBorrowed > 0 ? "red" : "zero" },
          { label: "Net Worth", value: fmt$(netWorth), tone: "green" },
          { label: "Lending APY", value: hasApy ? `${pos.supplyApy!.toFixed(2)}%` : "—", tone: hasApy && pos.supplyApy! > 0 ? "green" : "zero" },
          { label: "Borrowing APY", value: `${pos.borrowApy.toFixed(2)}%`, tone: pos.borrowApy > 0 ? "red" : "zero" },
          { label: "Net APY", value: hasApy ? `${netApy.toFixed(2)}%` : "—", tone: hasApy && netApy > 0 ? "green" : "zero" },
          { label: "Daily Cashflow", value: hasApy ? `+${fmt$(dailyCashflow, 4)}` : "—", tone: hasApy && dailyCashflow > 0 ? "green" : "zero" },
          { label: "Monthly Cashflow", value: hasApy ? `+${fmt$(dailyCashflow * 30)}` : "—", tone: hasApy && dailyCashflow > 0 ? "green" : "zero" },
          { label: "Yearly Cashflow", value: hasApy ? `+${fmt$(dailyCashflow * 365)}` : "—", tone: hasApy && dailyCashflow > 0 ? "green" : "zero" },
        ]}
      />
      {pos.suppliedAssets.length > 0 && (
        <AssetsBlock label="↑ Supplied Assets">
          {pos.suppliedAssets.map((a) => (
            <AssetRow
              key={a.symbol}
              symbol={a.symbol}
              apyLabel={a.apy !== null ? `APY: ${a.apy.toFixed(2)}%` : "APY unavailable"}
              value={a.usdValue > 0 ? fmt$(a.usdValue) : "—"}
              amount={`${fmtBalance(a.amount)} ${a.symbol}`}
            />
          ))}
        </AssetsBlock>
      )}
      {pos.borrowedAssets.length > 0 && (
        <AssetsBlock label="↓ Borrowed Assets" tone="red">
          {pos.borrowedAssets.map((a) => (
            <AssetRow
              key={a.symbol}
              symbol={a.symbol}
              apyLabel="Borrowed"
              apyTone="red"
              value={a.usdValue > 0 ? fmt$(a.usdValue) : "—"}
              valueTone="red"
              amount={`${fmtBalance(a.amount)} ${a.symbol}`}
            />
          ))}
        </AssetsBlock>
      )}
      <ManageButton href={pos.manageUrl} label={pos.protocol} />
    </div>
  );
}

// ── Card header ──────────────────────────────────────────────────────────────
function CardHeader({
  sym,
  name,
  rightValue,
  rightLabel,
}: {
  sym: string;
  name: string;
  rightValue: string;
  rightLabel: string;
}) {
  return (
    <div className="flex items-center justify-between px-6 py-5 border-b border-[#1c1c1c] gap-3 flex-wrap">
      <div className="flex items-center gap-3.5">
        <div
          className="flex items-center justify-center"
          style={{
            width: 36,
            height: 36,
            border: "1px solid #262626",
            background: "#0d0d0d",
            color: "#00ff41",
            fontSize: 14,
            fontWeight: 700,
          }}
        >
          {sym}
        </div>
        <div>
          <div
            className="font-bold"
            style={{ fontSize: 17, color: "#f0f0f0", letterSpacing: "0.02em" }}
          >
            {name}
          </div>
          <div
            className="inline-flex items-center mt-1.5 px-2"
            style={{
              fontSize: 10,
              color: "#00ff41",
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              border: "1px solid #00992a",
              background: "rgba(0,255,65,0.06)",
              padding: "2px 8px",
              fontWeight: 600,
            }}
          >
            [Lending]
          </div>
        </div>
      </div>
      <div className="text-right">
        <div
          className="font-bold tabular-nums"
          style={{
            fontSize: 28,
            color: "#00ff41",
            letterSpacing: "-0.02em",
            textShadow: "0 0 18px rgba(0,255,65,0.2)",
          }}
        >
          {rightValue}
        </div>
        <div
          className="mt-0.5"
          style={{
            fontSize: 10,
            color: "#a0a0a0",
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            opacity: 0.5,
          }}
        >
          {rightLabel}
        </div>
      </div>
    </div>
  );
}

function MetricGrid({
  cells,
}: {
  cells: { label: string; value: string; tone?: "bright" | "green" | "dim" | "zero" | "red" }[];
}) {
  // 3-column grid of 9 cells. Last column has no right border, last row has no bottom border.
  return (
    <div
      className="grid grid-cols-3"
      style={{
        // negative margins to hide outer right/bottom borders
        marginRight: -1,
        marginBottom: -1,
      }}
    >
      {cells.map((c, i) => (
        <MetricCell key={i} label={c.label} value={c.value} tone={c.tone} />
      ))}
    </div>
  );
}

function AssetsBlock({
  label,
  tone = "green",
  children,
}: {
  label: string;
  tone?: "green" | "red";
  children: React.ReactNode;
}) {
  return (
    <div className="px-6 py-4 border-t border-[#1c1c1c]" style={{ background: "#0d0d0d" }}>
      <div
        className="mb-3 flex items-center gap-1.5"
        style={{
          fontSize: 10,
          letterSpacing: "0.22em",
          textTransform: "uppercase",
          color: tone === "green" ? "#00ff41" : "#ff3355",
        }}
      >
        {label}
      </div>
      <div>{children}</div>
    </div>
  );
}

function AssetRow({
  symbol,
  logo,
  apyLabel,
  apyTone = "default",
  value,
  valueTone = "bright",
  amount,
}: {
  symbol: string;
  logo?: string;
  apyLabel: string;
  apyTone?: "default" | "red";
  value: string;
  valueTone?: "bright" | "red";
  amount: string;
}) {
  return (
    <div className="flex items-center gap-3.5 py-2.5 border-b border-[#1c1c1c] last:border-b-0">
      <TokenIcon symbol={symbol} logo={logo} size={26} />
      <div>
        <div className="font-bold" style={{ fontSize: 14, color: "#e0e0e0" }}>
          {symbol}
        </div>
        <div
          className="mt-0.5"
          style={{
            fontSize: 11,
            color: apyTone === "red" ? "#ff3355" : "#a0a0a0",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          {apyLabel}
        </div>
      </div>
      <div className="flex-1" />
      <div className="text-right">
        <div
          className="font-bold tabular-nums"
          style={{ fontSize: 15, color: valueTone === "red" ? "#ff3355" : "#f0f0f0" }}
        >
          {value}
        </div>
        <div
          className="mt-0.5"
          style={{ fontSize: 11, color: "#a0a0a0", opacity: 0.55 }}
        >
          {amount}
        </div>
      </div>
    </div>
  );
}

function ManageButton({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="block w-full text-center border-t border-[#1c1c1c] no-underline transition-all"
      style={{
        padding: 14,
        background: "rgba(0,255,65,0.06)",
        color: "#00ff41",
        fontSize: 14,
        fontWeight: 600,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "rgba(0,255,65,0.12)";
        e.currentTarget.style.boxShadow = "inset 0 0 24px rgba(0,255,65,0.08)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "rgba(0,255,65,0.06)";
        e.currentTarget.style.boxShadow = "none";
      }}
    >
      Manage on {label} ↗
    </a>
  );
}
