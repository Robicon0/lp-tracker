"use client";

import { useState, useMemo, type CSSProperties } from "react";
import Link from "next/link";
import Navbar from "../../Navbar";
import { useAccount } from "wagmi";
import { useWalletAuth } from "../../contexts/WalletAuthContext";
import { useWalletTokens, type TokenItem } from "../../hooks/useWalletTokens";
import { getTokenLogo, TOKEN_COLORS } from "../../lib/tokenLogos";

const CHAIN_COLORS: Record<string, string> = {
  Ethereum: "#627eea",
  Base:     "#0052ff",
  Arbitrum: "#2d9cdb",
  Optimism: "#ff0420",
  Polygon:  "#8247e5",
};

// Inline TokenIcon (circular, with error fallback)
function TokenIcon({ symbol, size = 28, logo, style }: {
  symbol: string; size?: number; logo?: string; style?: CSSProperties;
}) {
  const [err, setErr] = useState(false);
  const src = (!err && (logo || getTokenLogo(symbol))) || null;
  const color = TOKEN_COLORS[symbol] ?? TOKEN_COLORS[symbol.toUpperCase()] ?? "#6B7280";
  const base: CSSProperties = {
    width: size, height: size, borderRadius: "50%",
    flexShrink: 0, display: "inline-block", ...style,
  };
  if (src) {
    return <img src={src} alt={symbol} onError={() => setErr(true)}
      style={{ ...base, objectFit: "cover" }} />;
  }
  return (
    <div style={{ ...base, background: color,
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.38, fontWeight: 700, color: "white" }}>
      {symbol.charAt(0).toUpperCase()}
    </div>
  );
}

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

export default function TokensPage() {
  const { address } = useAccount();
  const { solanaAddress, suiAddress } = useWalletAuth();
  const hasWallet = !!(address || solanaAddress || suiAddress);
  const { tokens, totalTokenValue, tokenCount, isLoading } = useWalletTokens();

  const [search, setSearch] = useState("");
  const [hideDust, setHideDust] = useState(false);
  const [hideUnknown, setHideUnknown] = useState(true);

  // Only regular (non-lending, non-debt) tokens
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

  // Group by chain, sorted by total USD value desc
  const byChain = useMemo(() => {
    const map = new Map<string, TokenItem[]>();
    for (const t of filtered) {
      const arr = map.get(t.chain) ?? [];
      arr.push(t);
      map.set(t.chain, arr);
    }
    // Sort tokens within each chain by USD value desc
    for (const [, arr] of map) arr.sort((a, b) => b.usdValue - a.usdValue);
    // Sort chains by total value desc
    return [...map.entries()]
      .map(([chain, toks]) => ({ chain, toks, total: toks.reduce((s, t) => s + t.usdValue, 0) }))
      .sort((a, b) => b.total - a.total);
  }, [filtered]);

  const uniqueChains = new Set(regularTokens.map((t) => t.chain)).size;

  return (
    <div style={{ background: "#060d08", minHeight: "100vh", color: "white" }}>
      <Navbar />
      <div style={{ maxWidth: 1000, margin: "0 auto", padding: "80px 24px 60px" }}>

        {/* Back + header */}
        <Link href="/dashboard" style={{ display: "inline-flex", alignItems: "center", gap: 6,
          fontSize: 13, color: "rgba(255,255,255,0.4)", textDecoration: "none", marginBottom: 24 }}>
          ← Back to Dashboard
        </Link>
        <h1 style={{ fontSize: 30, fontWeight: 700, margin: "0 0 6px" }}>Token Holdings</h1>
        <p style={{ fontSize: 14, color: "rgba(255,255,255,0.4)", margin: "0 0 28px" }}>
          Token balances across all connected wallets
        </p>

        {/* Total value card */}
        <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)",
          borderRadius: 14, padding: "20px 24px", marginBottom: 24,
          display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
          <div>
            <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1,
              color: "rgba(255,255,255,0.35)", margin: "0 0 6px" }}>Total Token Value</p>
            {isLoading ? (
              <p style={{ fontSize: 32, fontWeight: 700, color: "rgba(255,255,255,0.3)", margin: 0 }}>Loading…</p>
            ) : (
              <p style={{ fontSize: 32, fontWeight: 700, color: "white", margin: 0, letterSpacing: -1 }}>
                {fmt$(totalTokenValue)}
              </p>
            )}
          </div>
          <p style={{ fontSize: 13, color: "rgba(255,255,255,0.4)", margin: 0 }}>
            {isLoading ? "Fetching balances…" : `${tokenCount} token${tokenCount === 1 ? "" : "s"} across ${uniqueChains} chain${uniqueChains === 1 ? "" : "s"}`}
          </p>
        </div>

        {/* No wallet */}
        {!hasWallet && (
          <div style={{ textAlign: "center", padding: "60px 0" }}>
            <p style={{ fontSize: 16, color: "rgba(255,255,255,0.4)", marginBottom: 24 }}>
              Connect a wallet to see your token holdings.
            </p>
            <Link href="/dashboard" style={{ background: "rgba(16,185,129,0.2)",
              border: "1px solid rgba(16,185,129,0.3)", color: "#6ee7b7",
              borderRadius: 10, padding: "10px 20px", textDecoration: "none", fontSize: 14 }}>
              Go to Dashboard
            </Link>
          </div>
        )}

        {hasWallet && (
          <>
            {/* Filters */}
            <div style={{ display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap", alignItems: "center" }}>
              <input
                type="text"
                placeholder="Search tokens…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{ flex: 1, minWidth: 160, background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10,
                  padding: "8px 14px", color: "white", fontSize: 13, outline: "none" }}
              />
              {[
                { label: "Hide dust < $1", value: hideDust, set: setHideDust },
                { label: "Hide unknown tokens", value: hideUnknown, set: setHideUnknown },
              ].map(({ label, value, set }) => (
                <button key={label} onClick={() => set(!value)}
                  style={{ background: value ? "rgba(251,191,36,0.15)" : "rgba(255,255,255,0.04)",
                    border: `1px solid ${value ? "rgba(251,191,36,0.3)" : "rgba(255,255,255,0.08)"}`,
                    color: value ? "#FBBF24" : "rgba(255,255,255,0.45)",
                    borderRadius: 10, padding: "7px 14px", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap" }}>
                  {value ? "✓ " : ""}{label}
                </button>
              ))}
            </div>

            {/* Chain sections */}
            {isLoading && byChain.length === 0 ? (
              <div style={{ textAlign: "center", padding: "60px 0", color: "rgba(255,255,255,0.3)" }}>
                <div style={{ width: 28, height: 28, border: "2px solid #10b981",
                  borderTopColor: "transparent", borderRadius: "50%", margin: "0 auto 16px",
                  animation: "spin 1s linear infinite" }} />
                <style>{`@keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }`}</style>
                Fetching token balances…
              </div>
            ) : byChain.length === 0 ? (
              <div style={{ textAlign: "center", padding: "60px 0", color: "rgba(255,255,255,0.3)" }}>
                No tokens found{search ? ` matching "${search}"` : ""}.
              </div>
            ) : byChain.map(({ chain, toks, total }) => (
              <div key={chain} style={{ marginBottom: 28 }}>
                {/* Chain header */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                  marginBottom: 8, paddingBottom: 8, borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%",
                      background: CHAIN_COLORS[chain] ?? "#6b7280" }} />
                    <span style={{ fontSize: 14, fontWeight: 600, color: "white" }}>{chain}</span>
                    <span style={{ fontSize: 12, color: "rgba(255,255,255,0.3)" }}>
                      {toks.length} token{toks.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <span style={{ fontSize: 14, fontWeight: 600, color: "white" }}>
                    {total > 0 ? fmt$(total) : "—"}
                  </span>
                </div>

                {/* Token rows */}
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {toks.map((token) => (
                    <div key={token.contractAddress}
                      style={{ display: "flex", alignItems: "center", gap: 12,
                        padding: "10px 12px", borderRadius: 10,
                        background: "rgba(255,255,255,0.02)",
                        border: "1px solid rgba(255,255,255,0.04)",
                        opacity: token.price === 0 ? 0.5 : 1 }}>
                      <TokenIcon symbol={token.symbol} size={32} logo={token.logo} />
                      <div style={{ flex: 1, overflow: "hidden" }}>
                        <p style={{ fontSize: 14, fontWeight: 600, color: "white", margin: 0 }}>
                          {token.symbol}
                        </p>
                        <p style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", margin: 0,
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {token.name}
                        </p>
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        <p style={{ fontSize: 14, fontWeight: 600, color: "white", margin: 0 }}>
                          {token.price > 0 ? fmt$(token.usdValue) : "—"}
                        </p>
                        <p style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", margin: 0 }}>
                          {fmtBalance(token.balance)} {token.symbol}
                          {token.price > 0 && (
                            <span style={{ marginLeft: 4, color: "rgba(255,255,255,0.2)" }}>
                              @ {fmt$(token.price, token.price < 0.01 ? 6 : 2)}
                            </span>
                          )}
                          {token.price === 0 && (
                            <span style={{ marginLeft: 4, color: "rgba(255,100,100,0.5)" }}>no price data</span>
                          )}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
