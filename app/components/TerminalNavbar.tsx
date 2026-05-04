"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type CSSProperties } from "react";
import { useAccount } from "wagmi";
import { useWalletAuth } from "../contexts/WalletAuthContext";

const NAV_LINKS = [
  { href: "/", label: "HOME" },
  { href: "/dashboard", label: "DASHBOARD" },
  { href: "/analytics", label: "ANALYTICS" },
  { href: "/about", label: "ABOUT" },
];

const TICKER_IDS = [
  { id: "bitcoin", label: "BTC" },
  { id: "ethereum", label: "ETH" },
  { id: "solana", label: "SOL" },
] as const;

function truncate(addr: string, head = 5, tail = 4) {
  return addr.length > head + tail + 2 ? `${addr.slice(0, head)}…${addr.slice(-tail)}` : addr;
}

export default function TerminalNavbar() {
  const pathname = usePathname() ?? "/";
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const { address } = useAccount();
  const { solanaAddress, suiAddress } = useWalletAuth();

  const [prices, setPrices] = useState<Record<string, number>>({});
  useEffect(() => {
    fetch(
      "/api/prices?endpoint=coins/markets&ids=bitcoin,ethereum,solana&vs_currencies=usd&order=market_cap_desc",
    )
      .then((r) => r.json())
      .then((data: Array<{ id: string; current_price: number }>) => {
        const map: Record<string, number> = {};
        for (const d of data) if (d.current_price) map[d.id] = d.current_price;
        setPrices(map);
      })
      .catch(() => {});
  }, []);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

  const linkStyle = (active: boolean): CSSProperties => ({
    fontSize: 11,
    letterSpacing: "0.08em",
    color: active ? "#00ff41" : "#555",
    textTransform: "uppercase",
    textDecoration: "none",
    paddingBottom: 4,
    borderBottom: active ? "1px solid #00ff41" : "1px solid transparent",
    transition: "color 0.15s, border-color 0.15s",
  });

  const tagStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 8px",
    background: "#090909",
    border: "1px solid #1c1c1c",
    fontSize: 10,
    letterSpacing: "0.06em",
    color: "#c8c8c8",
    cursor: "pointer",
    fontFamily: "var(--font-jetbrains-mono), monospace",
  };

  const priceStyle: CSSProperties = {
    fontSize: 10,
    letterSpacing: "0.04em",
    color: "#c8c8c8",
    fontFamily: "var(--font-jetbrains-mono), monospace",
    whiteSpace: "nowrap",
  };

  return (
    <nav
      className="sticky top-0 z-[10000] flex items-center justify-between gap-4 px-4 sm:px-8 lg:px-12 border-b border-[#1c1c1c]"
      style={{
        background: "#000",
        height: 52,
        fontFamily: "var(--font-jetbrains-mono), monospace",
      }}
    >
      {/* Left: logo */}
      <Link
        href="/"
        style={{
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          textDecoration: "none",
          flexShrink: 0,
        }}
      >
        <span style={{ color: "#00ff41" }}>DEFI</span>
        <span style={{ color: "#555" }}>/</span>
        <span style={{ color: "#555" }}>DESH</span>
      </Link>

      {/* Middle: nav links */}
      <div className="hidden md:flex items-center gap-7" style={{ flexShrink: 0 }}>
        {NAV_LINKS.map((l) => (
          <Link key={l.href} href={l.href} style={linkStyle(isActive(l.href))}>
            {l.label}
          </Link>
        ))}
      </div>

      {/* Right: prices + wallet tags + LIVE */}
      <div className="flex items-center gap-3" style={{ minWidth: 0 }}>
        {/* Prices — hidden below lg */}
        <div className="hidden lg:flex items-center gap-3" style={{ flexShrink: 0 }}>
          {TICKER_IDS.map(({ id, label }) =>
            prices[id] ? (
              <span key={id} style={priceStyle}>
                <span style={{ color: "#555" }}>{label}</span>{" "}
                <span style={{ color: "#c8c8c8" }}>
                  ${prices[id].toLocaleString("en-US", {
                    maximumFractionDigits: id === "bitcoin" ? 0 : 2,
                  })}
                </span>
              </span>
            ) : null,
          )}
        </div>

        {/* Wallet tags — hidden below md */}
        <div className="hidden md:flex items-center gap-2" style={{ flexShrink: 0 }}>
          {mounted && address && (
            <button
              type="button"
              title="Copy EVM address"
              onClick={() => navigator.clipboard.writeText(address)}
              style={tagStyle}
            >
              <span style={{ color: "#00e5ff", fontWeight: 700 }}>EVM</span>
              <span style={{ color: "#7a7a7a" }}>{truncate(address, 5, 4)}</span>
            </button>
          )}
          {mounted && solanaAddress && (
            <button
              type="button"
              title="Copy Solana address"
              onClick={() => navigator.clipboard.writeText(solanaAddress)}
              style={tagStyle}
            >
              <span style={{ color: "#9945ff", fontWeight: 700 }}>SOL</span>
              <span style={{ color: "#7a7a7a" }}>{truncate(solanaAddress, 4, 4)}</span>
            </button>
          )}
          {mounted && suiAddress && (
            <button
              type="button"
              title="Copy Sui address"
              onClick={() => navigator.clipboard.writeText(suiAddress)}
              style={tagStyle}
            >
              <span style={{ color: "#4da2ff", fontWeight: 700 }}>SUI</span>
              <span style={{ color: "#7a7a7a" }}>{truncate(suiAddress, 5, 4)}</span>
            </button>
          )}
        </div>

        {/* LIVE badge */}
        <div
          className="flex items-center gap-2"
          style={{
            padding: "5px 10px",
            border: "1px solid #00cc33",
            background: "rgba(0,255,65,0.08)",
            flexShrink: 0,
          }}
        >
          <span
            className="animate-pulse"
            style={{ width: 6, height: 6, background: "#00ff41", display: "inline-block" }}
          />
          <span
            style={{
              fontSize: 10,
              letterSpacing: "0.1em",
              color: "#00ff41",
              textTransform: "uppercase",
            }}
            className="hidden sm:inline"
          >
            LIVE
          </span>
        </div>
      </div>
    </nav>
  );
}
