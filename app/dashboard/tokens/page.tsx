"use client";

import { useState, useMemo, type CSSProperties } from "react";
import Link from "next/link";
import TerminalNav from "../../components/TerminalNav";
import AnimatedCount from "../../components/AnimatedCount";
import { useAccount } from "wagmi";
import { useWalletAuth } from "../../contexts/WalletAuthContext";
import { useWalletTokens, type TokenItem } from "../../hooks/useWalletTokens";
import { getTokenLogo, TOKEN_COLORS } from "../../lib/tokenLogos";

// EVM chain set — any chain added here automatically groups under the EVM section
const EVM_CHAINS = new Set([
  "Ethereum", "Base", "Arbitrum", "Optimism", "Polygon",
  "BNB Chain", "Avalanche", "HyperEVM",
]);

const CHAIN_COLORS: Record<string, string> = {
  Ethereum: "#627eea",
  Base: "#0052ff",
  Arbitrum: "#2d9cdb",
  Optimism: "#ff0420",
  Polygon: "#8247e5",
  "BNB Chain": "#f0b90b",
  Avalanche: "#e84142",
  HyperEVM: "#00d4aa",
  Solana: "#9945ff",
  Sui: "#3d9fff",
};

function fmt$(n: number, dec = 2) {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;
}
function fmtBalance(n: number) {
  if (n === 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return n.toFixed(6);
}

const SCANLINE =
  "repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(0,0,0,0.012) 3px, rgba(0,0,0,0.012) 4px)";

// ── Token icon ────────────────────────────────────────────────────────────────
function TokenIcon({
  symbol,
  size = 32,
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
        fontSize: size * 0.34,
        fontWeight: 700,
      }}
    >
      {symbol.charAt(0).toUpperCase()}
    </div>
  );
}

// ── Donut chart (chain breakdown) ─────────────────────────────────────────────
function Donut({
  data,
  size = 92,
}: {
  data: { pct: number; color: string; name: string }[];
  size?: number;
}) {
  const r = 34;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;
  let off = 0;
  const slices = data.map((d) => {
    const dash = (d.pct / 100) * circ;
    const slice = { ...d, off, dash };
    off += dash;
    return slice;
  });
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#111" strokeWidth="14" />
      {slices.map((s, i) => (
        <circle
          key={i}
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke={s.color}
          strokeWidth="13"
          strokeDasharray={`${s.dash} ${circ - s.dash}`}
          strokeDashoffset={-s.off}
          transform={`rotate(-90 ${cx} ${cy})`}
          style={{ filter: `drop-shadow(0 0 4px ${s.color}66)` }}
        />
      ))}
    </svg>
  );
}

// ── Token row ────────────────────────────────────────────────────────────────
function TokenRow({ token }: { token: TokenItem }) {
  const change = token.change24h;
  const showChange = change !== null && Number.isFinite(change);
  return (
    <div
      className="flex items-center gap-3.5 px-6 py-3 border-b border-[#1c1c1c] last:border-b-0 transition-colors"
      style={{ background: "transparent" }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "rgba(255,255,255,0.012)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      <TokenIcon symbol={token.symbol} logo={token.logo} size={32} />
      <div className="flex-1 min-w-0">
        <div
          className="font-bold truncate"
          style={{ fontSize: 12, color: "#e0e0e0", letterSpacing: "0.04em" }}
        >
          {token.symbol}
        </div>
        <div
          className="mt-0.5 truncate"
          style={{
            fontSize: 9,
            color: "#7a7a7a",
            opacity: 0.5,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          {token.name}
        </div>
      </div>
      {showChange ? (
        <div
          className="tabular-nums"
          style={{
            fontSize: 9,
            fontWeight: 700,
            padding: "3px 8px",
            border: "1px solid",
            borderColor: change! >= 0 ? "#00992a" : "rgba(255,51,85,0.3)",
            background:
              change! >= 0 ? "rgba(0,255,65,0.06)" : "rgba(255,51,85,0.06)",
            color: change! >= 0 ? "#00ff41" : "#ff3355",
            letterSpacing: "0.06em",
          }}
        >
          {change! >= 0 ? "+" : ""}
          {change!.toFixed(2)}%
        </div>
      ) : (
        <div
          style={{
            fontSize: 9,
            fontWeight: 700,
            padding: "3px 8px",
            border: "1px solid #262626",
            color: "#7a7a7a",
            letterSpacing: "0.06em",
            opacity: 0.6,
          }}
        >
          — no price
        </div>
      )}
      <div className="text-right" style={{ minWidth: 140 }}>
        {token.price > 0 ? (
          <>
            <div
              className="font-bold tabular-nums"
              style={{ fontSize: 13, color: "#f0f0f0" }}
            >
              {fmt$(token.usdValue)}
            </div>
            <div
              className="mt-0.5 tabular-nums"
              style={{ fontSize: 9, color: "#7a7a7a", opacity: 0.55, letterSpacing: "0.04em" }}
            >
              {fmtBalance(token.balance)} {token.symbol} @ {fmt$(token.price, token.price < 0.01 ? 6 : 2)}
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 13, color: "#7a7a7a", opacity: 0.4 }}>—</div>
            <div
              className="mt-0.5 tabular-nums"
              style={{ fontSize: 9, color: "#7a7a7a", opacity: 0.55, letterSpacing: "0.04em" }}
            >
              {fmtBalance(token.balance)} {token.symbol}
              <span className="ml-1.5" style={{ color: "#ff3355", opacity: 0.7 }}>
                no price data
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Chain section ─────────────────────────────────────────────────────────────
interface ChainGroup {
  chain: string;
  toks: TokenItem[];
  total: number;
}

function ChainSection({
  title,
  color,
  total,
  tokenCount,
  children,
}: {
  title: string;
  color: string;
  total: number;
  tokenCount: number;
  children: React.ReactNode;
}) {
  return (
    <div
      className="mb-6 border border-[#1c1c1c]"
      style={{ background: "#090909", animation: "wal-fade-up 0.5s ease both" }}
    >
      <div
        className="flex items-center justify-between px-6 py-4 border-b border-[#1c1c1c]"
        style={{ background: "#0d0d0d" }}
      >
        <div className="flex items-center gap-3">
          <div
            style={{
              width: 9,
              height: 9,
              background: color,
              boxShadow: `0 0 6px ${color}99`,
            }}
          />
          <span
            className="font-bold"
            style={{ fontSize: 13, color: "#e0e0e0", letterSpacing: "0.04em" }}
          >
            {title}
          </span>
          <span
            style={{
              fontSize: 9,
              color: "#7a7a7a",
              opacity: 0.55,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
            }}
          >
            {tokenCount} token{tokenCount === 1 ? "" : "s"}
          </span>
        </div>
        <div
          className="font-bold tabular-nums"
          style={{
            fontSize: 18,
            color: "#00ff41",
            textShadow: "0 0 14px rgba(0,255,65,0.18)",
          }}
        >
          {total > 0 ? fmt$(total) : "—"}
        </div>
      </div>
      {children}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function TokensPage() {
  const { address } = useAccount();
  const { solanaAddress, suiAddress } = useWalletAuth();
  const hasWallet = !!(address || solanaAddress || suiAddress);
  const { tokens, totalTokenValue, tokenCount, isLoading } = useWalletTokens();

  const [search, setSearch] = useState("");
  const [hideDust, setHideDust] = useState(true);
  const [hideUnknown, setHideUnknown] = useState(true);

  const regularTokens = useMemo(
    () => tokens.filter((t) => !t.isLending && !t.isDebt),
    [tokens],
  );

  const filtered = useMemo(() => {
    let list = regularTokens;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (t) => t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q),
      );
    }
    if (hideDust) list = list.filter((t) => t.usdValue >= 1);
    if (hideUnknown) list = list.filter((t) => t.price > 0 || t.usdValue > 0);
    return list;
  }, [regularTokens, search, hideDust, hideUnknown]);

  // Group filtered tokens by chain
  const grouped = useMemo(() => {
    const chainMap = new Map<string, TokenItem[]>();
    for (const t of filtered) {
      const arr = chainMap.get(t.chain) ?? [];
      arr.push(t);
      chainMap.set(t.chain, arr);
    }
    for (const arr of chainMap.values()) arr.sort((a, b) => b.usdValue - a.usdValue);

    const evmGroups: ChainGroup[] = [];
    const nonEvmGroups: ChainGroup[] = [];
    for (const [chain, toks] of chainMap) {
      const total = toks.reduce((s, t) => s + t.usdValue, 0);
      if (EVM_CHAINS.has(chain)) evmGroups.push({ chain, toks, total });
      else nonEvmGroups.push({ chain, toks, total });
    }
    evmGroups.sort((a, b) => b.total - a.total);
    nonEvmGroups.sort((a, b) => b.total - a.total);
    return { evmGroups, nonEvmGroups };
  }, [filtered]);

  const evmTotal = grouped.evmGroups.reduce((s, g) => s + g.total, 0);
  const evmTokenCount = grouped.evmGroups.reduce((s, g) => s + g.toks.length, 0);
  const uniqueChains = new Set(regularTokens.map((t) => t.chain)).size;

  // Donut data: aggregate USD value per chain across all regular tokens
  const chainBreakdown = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of regularTokens) {
      if (t.usdValue <= 0) continue;
      map.set(t.chain, (map.get(t.chain) ?? 0) + t.usdValue);
    }
    const total = [...map.values()].reduce((s, v) => s + v, 0);
    if (total === 0) return [];
    return Array.from(map.entries())
      .map(([chain, value]) => ({
        chain,
        value,
        pct: (value / total) * 100,
        color: CHAIN_COLORS[chain] ?? "#7a7a7a",
      }))
      .sort((a, b) => b.value - a.value);
  }, [regularTokens]);

  const donutSlices = chainBreakdown.map((c) => ({
    pct: c.pct,
    color: c.color,
    name: c.chain,
  }));

  return (
    <div
      className="min-h-screen"
      style={{
        background: "#050505",
        color: "#7a7a7a",
        fontFamily: "var(--font-jetbrains-mono)",
        fontSize: 12,
        lineHeight: 1.5,
      }}
    >
      <style
        dangerouslySetInnerHTML={{
          __html:
            '@keyframes wal-fade-up { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: translateY(0) } } button[aria-label="Share feedback"] { display: none !important; }',
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
        style={{ animation: "wal-fade-up 0.4s ease both", maxWidth: 1280, margin: "0 auto" }}
      >
        {/* Back link */}
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-2 mb-5 text-[#7a7a7a] hover:text-[#00ff41] transition-colors no-underline"
          style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase" }}
        >
          ← Back to Dashboard
        </Link>

        {/* Eyebrow + title */}
        <div
          className="mb-1.5"
          style={{
            fontSize: 9,
            letterSpacing: "0.22em",
            textTransform: "uppercase",
            color: "#7a7a7a",
            opacity: 0.6,
          }}
        >
          <span className="text-[#00ff41]" style={{ opacity: 1 }}>// wallet</span> · idle balances across connected wallets
        </div>
        <h1
          className="font-bold mb-1.5"
          style={{ fontSize: 32, color: "#f0f0f0", letterSpacing: "-0.02em" }}
        >
          Wallet Balances
        </h1>
        <p className="mb-6" style={{ fontSize: 11, color: "#7a7a7a", opacity: 0.6 }}>
          Idle tokens across all connected wallets
        </p>

        {!hasWallet ? (
          <div className="text-center py-16">
            <p style={{ fontSize: 12, color: "#7a7a7a", marginBottom: 20 }}>
              Connect a wallet to see your token holdings.
            </p>
            <Link
              href="/dashboard"
              className="inline-block border border-[#00992a] text-[#00ff41] px-5 py-2.5 no-underline hover:bg-[rgba(0,255,65,0.08)] transition-colors"
              style={{
                fontSize: 11,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                background: "rgba(0,255,65,0.06)",
              }}
            >
              ▸ Go to Dashboard
            </Link>
          </div>
        ) : (
          <>
            {/* Summary: total + donut */}
            <div className="grid grid-cols-1 md:grid-cols-[2fr_1fr] gap-4 mb-6">
              <div
                className="border border-[#1c1c1c] px-7 py-6 flex items-center justify-between flex-wrap gap-3 relative"
                style={{ background: "#090909" }}
              >
                <div
                  className="absolute top-0 left-0 right-0 h-px"
                  style={{ background: "linear-gradient(90deg, transparent, #262626, transparent)" }}
                />
                <div>
                  <div
                    className="mb-2.5"
                    style={{
                      fontSize: 8,
                      letterSpacing: "0.2em",
                      textTransform: "uppercase",
                      color: "#7a7a7a",
                      opacity: 0.6,
                    }}
                  >
                    Total Wallet Balance
                  </div>
                  {isLoading ? (
                    <div
                      className="font-bold"
                      style={{ fontSize: 34, color: "#7a7a7a", letterSpacing: "-0.02em" }}
                    >
                      Loading…
                    </div>
                  ) : (
                    <div
                      className="font-bold tabular-nums"
                      style={{
                        fontSize: 34,
                        color: "#00ff41",
                        letterSpacing: "-0.02em",
                        textShadow: "0 0 22px rgba(0,255,65,0.22)",
                      }}
                    >
                      <AnimatedCount target={totalTokenValue} prefix="$" decimals={2} />
                    </div>
                  )}
                </div>
                <div
                  style={{
                    fontSize: 10,
                    color: "#7a7a7a",
                    opacity: 0.6,
                    letterSpacing: "0.04em",
                    textAlign: "right",
                  }}
                >
                  {isLoading
                    ? "Fetching balances…"
                    : `${tokenCount} token${tokenCount === 1 ? "" : "s"} across ${uniqueChains} chain${uniqueChains === 1 ? "" : "s"}`}
                </div>
              </div>

              <div
                className="border border-[#1c1c1c] px-6 py-5 flex items-center gap-4"
                style={{ background: "#090909" }}
              >
                {donutSlices.length > 0 ? (
                  <Donut data={donutSlices} size={92} />
                ) : (
                  <div
                    style={{
                      width: 92,
                      height: 92,
                      border: "1px solid #1c1c1c",
                      flexShrink: 0,
                    }}
                  />
                )}
                <div className="flex-1 min-w-0 flex flex-col gap-2">
                  <div
                    className="mb-1.5"
                    style={{
                      fontSize: 8,
                      letterSpacing: "0.2em",
                      textTransform: "uppercase",
                      color: "#7a7a7a",
                      opacity: 0.6,
                    }}
                  >
                    By Chain
                  </div>
                  {chainBreakdown.length === 0 ? (
                    <div style={{ fontSize: 10, color: "#7a7a7a", opacity: 0.5 }}>—</div>
                  ) : (
                    chainBreakdown.slice(0, 5).map((c) => (
                      <div key={c.chain} className="flex items-center gap-2" style={{ fontSize: 10 }}>
                        <div
                          style={{
                            width: 6,
                            height: 6,
                            background: c.color,
                            boxShadow: `0 0 4px ${c.color}88`,
                            flexShrink: 0,
                          }}
                        />
                        <span
                          className="flex-1 truncate"
                          style={{ color: "#aaaaaa" }}
                        >
                          {c.chain}
                        </span>
                        <span
                          className="font-bold tabular-nums"
                          style={{ color: "#e0e0e0" }}
                        >
                          {c.pct.toFixed(0)}%
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            {/* Controls */}
            <div
              className="flex items-stretch border border-[#1c1c1c] mb-4 flex-wrap"
              style={{ background: "#090909" }}
            >
              <div className="flex-1 flex items-center px-3.5 border-r border-[#1c1c1c] min-w-[180px]">
                <span
                  className="mr-2.5 text-[#00ff41]"
                  style={{ fontSize: 11 }}
                >
                  &gt;_
                </span>
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="search tokens..."
                  className="flex-1 bg-transparent outline-none border-none"
                  style={{
                    fontFamily: "var(--font-jetbrains-mono)",
                    fontSize: 11,
                    color: "#e0e0e0",
                    padding: "12px 0",
                  }}
                />
              </div>
              <ToggleBtn label="Hide dust < $1" value={hideDust} onChange={setHideDust} />
              <ToggleBtn label="Hide unknown tokens" value={hideUnknown} onChange={setHideUnknown} />
            </div>

            {/* Sections */}
            {isLoading && grouped.evmGroups.length === 0 && grouped.nonEvmGroups.length === 0 ? (
              <div className="text-center py-16" style={{ color: "#7a7a7a" }}>
                <div
                  className="mx-auto mb-4"
                  style={{
                    width: 24,
                    height: 24,
                    border: "2px solid #00ff41",
                    borderTopColor: "transparent",
                    animation: "wal-spin 1s linear infinite",
                  }}
                />
                <style>{"@keyframes wal-spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }"}</style>
                <span style={{ fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                  Fetching token balances…
                </span>
              </div>
            ) : grouped.evmGroups.length === 0 && grouped.nonEvmGroups.length === 0 ? (
              <div className="text-center py-16" style={{ color: "#7a7a7a", fontSize: 12 }}>
                No tokens found{search ? ` matching "${search}"` : ""}.
              </div>
            ) : (
              <>
                {/* EVM section — multi-chain */}
                {grouped.evmGroups.length > 0 && (
                  <ChainSection
                    title="EVM"
                    color="#627eea"
                    total={evmTotal}
                    tokenCount={evmTokenCount}
                  >
                    {grouped.evmGroups.map((cg, i) => (
                      <div
                        key={cg.chain}
                        className={i < grouped.evmGroups.length - 1 ? "border-b border-[#1c1c1c]" : ""}
                      >
                        <div
                          className="flex items-center justify-between px-6 py-2.5"
                          style={{ background: "#0a0a0a" }}
                        >
                          <div className="flex items-center gap-2.5">
                            <div
                              style={{
                                width: 7,
                                height: 7,
                                background: CHAIN_COLORS[cg.chain] ?? "#7a7a7a",
                              }}
                            />
                            <span
                              style={{
                                fontSize: 11,
                                color: "#aaaaaa",
                                fontWeight: 600,
                                letterSpacing: "0.04em",
                              }}
                            >
                              {cg.chain}
                            </span>
                            <span
                              style={{
                                fontSize: 9,
                                color: "#7a7a7a",
                                opacity: 0.55,
                                letterSpacing: "0.1em",
                                textTransform: "uppercase",
                              }}
                            >
                              {cg.toks.length} token{cg.toks.length === 1 ? "" : "s"}
                            </span>
                          </div>
                          <span
                            className="font-bold tabular-nums"
                            style={{ fontSize: 12, color: "#aaaaaa" }}
                          >
                            {cg.total > 0 ? fmt$(cg.total) : "—"}
                          </span>
                        </div>
                        {cg.toks.map((t) => (
                          <TokenRow key={`${t.chain}-${t.contractAddress}`} token={t} />
                        ))}
                      </div>
                    ))}
                  </ChainSection>
                )}

                {/* Non-EVM sections */}
                {grouped.nonEvmGroups.map((cg) => (
                  <ChainSection
                    key={cg.chain}
                    title={cg.chain}
                    color={CHAIN_COLORS[cg.chain] ?? "#7a7a7a"}
                    total={cg.total}
                    tokenCount={cg.toks.length}
                  >
                    {cg.toks.map((t) => (
                      <TokenRow key={`${t.chain}-${t.contractAddress}`} token={t} />
                    ))}
                  </ChainSection>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ToggleBtn({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className="flex items-center gap-1.5 px-4 border-r border-[#1c1c1c] last:border-r-0 transition-colors"
      style={{
        fontFamily: "var(--font-jetbrains-mono)",
        fontSize: 9,
        height: 42,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        background: value ? "rgba(0,255,65,0.06)" : "transparent",
        color: value ? "#00ff41" : "#7a7a7a",
        border: "none",
        borderRight: "1px solid #1c1c1c",
        cursor: "pointer",
      }}
    >
      <span
        className="inline-flex items-center justify-center"
        style={{
          width: 9,
          height: 9,
          border: `1px solid ${value ? "#00992a" : "#262626"}`,
          background: value ? "rgba(0,255,65,0.06)" : "transparent",
          color: "#00ff41",
          fontSize: 7,
        }}
      >
        {value ? "✓" : ""}
      </span>
      {label}
    </button>
  );
}
