"use client";

import { useState, useMemo, type CSSProperties } from "react";
import Link from "next/link";
import TerminalNav from "../../components/TerminalNav";
import PageBackdrop from "../../components/PageBackdrop";
import AnimatedCount from "../../components/AnimatedCount";
import { useWalletAuth } from "../../contexts/WalletAuthContext";
import { useWatchedWallets } from "../../contexts/WatchedWalletsContext";
import { useWalletTokens, type TokenItem } from "../../hooks/useWalletTokens";
import { getTokenLogo, TOKEN_COLORS } from "../../lib/tokenLogos";

// EVM chain set — any chain added here automatically groups under the EVM section
const EVM_CHAINS = new Set([
  "Ethereum", "Base", "Arbitrum", "Optimism", "Polygon",
  "BNB Chain", "Avalanche", "HyperEVM",
]);

const CHAIN_COLORS: Record<string, string> = {
  Ethereum: "var(--chain-ethereum)",
  Base: "var(--chain-base)",
  Arbitrum: "#2d9cdb",
  Optimism: "var(--chain-optimism)",
  Polygon: "var(--chain-polygon)",
  "BNB Chain": "var(--chain-bnb)",
  Avalanche: "var(--chain-avalanche)",
  HyperEVM: "var(--pos)",
  Solana: "var(--chain-solana)",
  Sui: "var(--info)",
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
  "repeating-linear-gradient(0deg, transparent, transparent 3px, var(--scanline) 3px, var(--scanline) 4px)";

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
  const color = TOKEN_COLORS[symbol] ?? TOKEN_COLORS[symbol.toUpperCase()] ?? "var(--line-strong)";
  const base: CSSProperties = {
    width: size,
    height: size,
    flexShrink: 0,
    border: "1px solid var(--line-strong)",
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
        color: "var(--fg)",
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
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--surface)" strokeWidth="14" />
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
      className="flex items-center gap-3.5 px-6 py-3 border-b border-[var(--line)] last:border-b-0 transition-colors"
      style={{ background: "transparent" }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--surface-hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      <TokenIcon symbol={token.symbol} logo={token.logo} size={32} />
      <div className="flex-1 min-w-0">
        <div
          className="font-bold truncate"
          style={{ fontSize: 15, color: "var(--fg)", letterSpacing: "0.04em" }}
        >
          {token.symbol}
        </div>
        <div
          className="mt-0.5 truncate"
          style={{
            fontSize: 11,
            color: "var(--fg-muted)",
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
            fontSize: 11,
            fontWeight: 700,
            padding: "3px 8px",
            border: "1px solid",
            borderColor: change! >= 0 ? "var(--accent-hover)" : "color-mix(in srgb, var(--neg) 30%, transparent)",
            background:
              change! >= 0 ? "color-mix(in srgb, var(--accent) 6%, transparent)" : "color-mix(in srgb, var(--neg) 6%, transparent)",
            color: change! >= 0 ? "var(--accent)" : "var(--neg)",
            letterSpacing: "0.06em",
          }}
        >
          {change! >= 0 ? "+" : ""}
          {change!.toFixed(2)}%
        </div>
      ) : (
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            padding: "3px 8px",
            border: "1px solid var(--line-strong)",
            color: "var(--fg-muted)",
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
              style={{ fontSize: 16, color: "var(--fg)" }}
            >
              {fmt$(token.usdValue)}
            </div>
            <div
              className="mt-0.5 tabular-nums"
              style={{ fontSize: 11, color: "var(--fg-muted)", opacity: 0.55, letterSpacing: "0.04em" }}
            >
              {fmtBalance(token.balance)} {token.symbol} @ {fmt$(token.price, token.price < 0.01 ? 6 : 2)}
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 16, color: "var(--fg-muted)", opacity: 0.4 }}>—</div>
            <div
              className="mt-0.5 tabular-nums"
              style={{ fontSize: 11, color: "var(--fg-muted)", opacity: 0.55, letterSpacing: "0.04em" }}
            >
              {fmtBalance(token.balance)} {token.symbol}
              <span className="ml-1.5" style={{ color: "var(--neg)", opacity: 0.7 }}>
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
      className="mb-6 border border-[var(--line)]"
      style={{ background: "var(--surface)", animation: "wal-fade-up 0.5s ease both" }}
    >
      <div
        className="flex items-center justify-between px-6 py-4 border-b border-[var(--line)]"
        style={{ background: "var(--surface)" }}
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
            style={{ fontSize: 16, color: "var(--fg)", letterSpacing: "0.04em" }}
          >
            {title}
          </span>
          <span
            style={{
              fontSize: 11,
              color: "var(--fg-muted)",
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
            fontSize: 22,
            color: "var(--accent)",
            textShadow: "0 0 14px color-mix(in srgb, var(--accent) 18%, transparent)",
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
  const { evmAddress: address, solanaAddress, suiAddress } = useWalletAuth();
  const { watchedWallets, scanAddress } = useWatchedWallets();
  // hasWallet must mirror the active fetch set inside useWalletTokens —
  // wagmi adapter address, Solana/Sui wallet, watched wallets list, OR
  // scan-mode address. Otherwise the empty state hides the very data
  // useWalletTokens is happily fetching for a watched / scanned address.
  const hasWallet =
    scanAddress !== null ||
    !!(address || solanaAddress || suiAddress) ||
    watchedWallets.length > 0;
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
    if (hideDust) list = list.filter((t) => t.usdValue >= 0.01);
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
        color: CHAIN_COLORS[chain] ?? "var(--fg-muted)",
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
        background: "transparent",
        color: "var(--fg-muted)",
        fontFamily: "var(--font-jetbrains-mono)",
        fontSize: 15,
        lineHeight: 1.5,
      }}
    >
      <style
        dangerouslySetInnerHTML={{
          __html:
            '@keyframes wal-fade-up { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: translateY(0) } }',
        }}
      />
      <div
        aria-hidden
        className="fixed inset-0 pointer-events-none z-[9998]"
        style={{ background: SCANLINE }}
      />
      <PageBackdrop />
      <TerminalNav active="dashboard" />

      <div
        className="px-4 sm:px-10 py-8"
        style={{ animation: "wal-fade-up 0.4s ease both", maxWidth: 1280, margin: "0 auto" }}
      >
        {/* Back link */}
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-2 mb-5 text-[var(--fg-muted)] hover:text-[var(--accent)] transition-colors no-underline"
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
            color: "var(--fg-muted)",
            opacity: 0.6,
          }}
        >
          <span className="text-[var(--accent)]" style={{ opacity: 1 }}>// wallet</span> · idle balances across connected wallets
        </div>
        <h1
          className="font-bold mb-1.5"
          style={{ fontSize: 32, color: "var(--fg)", letterSpacing: "-0.02em" }}
        >
          Wallet Balances
        </h1>
        <p className="mb-6" style={{ fontSize: 14, color: "var(--fg-muted)", opacity: 0.6 }}>
          Idle tokens across all connected wallets
        </p>

        {!hasWallet ? (
          <div className="text-center py-16">
            <p style={{ fontSize: 15, color: "var(--fg-muted)", marginBottom: 20 }}>
              Connect a wallet to see your token holdings.
            </p>
            <Link
              href="/dashboard"
              className="inline-block border border-[var(--accent-hover)] text-[var(--accent)] px-5 py-2.5 no-underline hover:bg-[color-mix(in srgb, var(--accent) 8%, transparent)] transition-colors"
              style={{
                fontSize: 14,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                background: "color-mix(in srgb, var(--accent) 6%, transparent)",
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
                className="border border-[var(--line)] px-7 py-6 flex items-center justify-between flex-wrap gap-3 relative"
                style={{ background: "var(--surface)" }}
              >
                <div
                  className="absolute top-0 left-0 right-0 h-px"
                  style={{ background: "linear-gradient(90deg, transparent, var(--line-strong), transparent)" }}
                />
                <div>
                  <div
                    className="mb-2.5"
                    style={{
                      fontSize: 10,
                      letterSpacing: "0.2em",
                      textTransform: "uppercase",
                      color: "var(--fg-muted)",
                      opacity: 0.6,
                    }}
                  >
                    Total Wallet Balance
                  </div>
                  {isLoading ? (
                    <div
                      className="font-bold"
                      style={{ fontSize: 34, color: "var(--fg-muted)", letterSpacing: "-0.02em" }}
                    >
                      Loading…
                    </div>
                  ) : (
                    <div
                      className="font-bold tabular-nums"
                      style={{
                        fontSize: 34,
                        color: "var(--accent)",
                        letterSpacing: "-0.02em",
                        textShadow: "0 0 22px color-mix(in srgb, var(--accent) 22%, transparent)",
                      }}
                    >
                      <AnimatedCount target={totalTokenValue} prefix="$" decimals={2} />
                    </div>
                  )}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--fg-muted)",
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
                className="border border-[var(--line)] px-6 py-5 flex items-center gap-4"
                style={{ background: "var(--surface)" }}
              >
                {donutSlices.length > 0 ? (
                  <Donut data={donutSlices} size={92} />
                ) : (
                  <div
                    style={{
                      width: 92,
                      height: 92,
                      border: "1px solid var(--line)",
                      flexShrink: 0,
                    }}
                  />
                )}
                <div className="flex-1 min-w-0 flex flex-col gap-2">
                  <div
                    className="mb-1.5"
                    style={{
                      fontSize: 10,
                      letterSpacing: "0.2em",
                      textTransform: "uppercase",
                      color: "var(--fg-muted)",
                      opacity: 0.6,
                    }}
                  >
                    By Chain
                  </div>
                  {chainBreakdown.length === 0 ? (
                    <div style={{ fontSize: 12, color: "var(--fg-muted)", opacity: 0.5 }}>—</div>
                  ) : (
                    chainBreakdown.slice(0, 5).map((c) => (
                      <div key={c.chain} className="flex items-center gap-2" style={{ fontSize: 12 }}>
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
                          style={{ color: "var(--fg-muted)" }}
                        >
                          {c.chain}
                        </span>
                        <span
                          className="font-bold tabular-nums"
                          style={{ color: "var(--fg)" }}
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
              className="flex items-stretch border border-[var(--line)] mb-4 flex-wrap"
              style={{ background: "var(--surface)" }}
            >
              <div className="flex-1 flex items-center px-3.5 border-r border-[var(--line)] min-w-[180px]">
                <span
                  className="mr-2.5 text-[var(--accent)]"
                  style={{ fontSize: 14 }}
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
                    fontSize: 14,
                    color: "var(--fg)",
                    padding: "12px 0",
                  }}
                />
              </div>
              <ToggleBtn label="Hide dust < $0.01" value={hideDust} onChange={setHideDust} />
              <ToggleBtn label="Hide unknown tokens" value={hideUnknown} onChange={setHideUnknown} />
            </div>

            {/* Sections */}
            {isLoading && grouped.evmGroups.length === 0 && grouped.nonEvmGroups.length === 0 ? (
              <div className="text-center py-16" style={{ color: "var(--fg-muted)" }}>
                <div
                  className="mx-auto mb-4"
                  style={{
                    width: 24,
                    height: 24,
                    border: "2px solid var(--accent)",
                    borderTopColor: "transparent",
                    animation: "wal-spin 1s linear infinite",
                  }}
                />
                <style>{"@keyframes wal-spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }"}</style>
                <span style={{ fontSize: 14, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                  Fetching token balances…
                </span>
              </div>
            ) : grouped.evmGroups.length === 0 && grouped.nonEvmGroups.length === 0 ? (
              <div className="text-center py-16" style={{ color: "var(--fg-muted)", fontSize: 15 }}>
                No tokens found{search ? ` matching "${search}"` : ""}.
              </div>
            ) : (
              <>
                {/* EVM section — multi-chain */}
                {grouped.evmGroups.length > 0 && (
                  <ChainSection
                    title="EVM"
                    color="var(--chain-ethereum)"
                    total={evmTotal}
                    tokenCount={evmTokenCount}
                  >
                    {grouped.evmGroups.map((cg, i) => (
                      <div
                        key={cg.chain}
                        className={i < grouped.evmGroups.length - 1 ? "border-b border-[var(--line)]" : ""}
                      >
                        <div
                          className="flex items-center justify-between px-6 py-2.5"
                          style={{ background: "var(--surface)" }}
                        >
                          <div className="flex items-center gap-2.5">
                            <div
                              style={{
                                width: 7,
                                height: 7,
                                background: CHAIN_COLORS[cg.chain] ?? "var(--fg-muted)",
                              }}
                            />
                            <span
                              style={{
                                fontSize: 14,
                                color: "var(--fg-muted)",
                                fontWeight: 600,
                                letterSpacing: "0.04em",
                              }}
                            >
                              {cg.chain}
                            </span>
                            <span
                              style={{
                                fontSize: 11,
                                color: "var(--fg-muted)",
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
                            style={{ fontSize: 15, color: "var(--fg-muted)" }}
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
                    color={CHAIN_COLORS[cg.chain] ?? "var(--fg-muted)"}
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
      className="flex items-center gap-1.5 px-4 border-r border-[var(--line)] last:border-r-0 transition-colors"
      style={{
        fontFamily: "var(--font-jetbrains-mono)",
        fontSize: 11,
        height: 42,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        background: value ? "color-mix(in srgb, var(--accent) 6%, transparent)" : "transparent",
        color: value ? "var(--accent)" : "var(--fg-muted)",
        border: "none",
        borderRight: "1px solid var(--line)",
        cursor: "pointer",
      }}
    >
      <span
        className="inline-flex items-center justify-center"
        style={{
          width: 9,
          height: 9,
          border: `1px solid ${value ? "var(--accent-hover)" : "var(--line-strong)"}`,
          background: value ? "color-mix(in srgb, var(--accent) 6%, transparent)" : "transparent",
          color: "var(--accent)",
          fontSize: 7,
        }}
      >
        {value ? "✓" : ""}
      </span>
      {label}
    </button>
  );
}
