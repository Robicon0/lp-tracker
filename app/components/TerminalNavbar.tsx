"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type CSSProperties } from "react";
import { useWalletAuth } from "../contexts/WalletAuthContext";
import { useWatchedWallets } from "../contexts/WatchedWalletsContext";
import MobileNavMenu from "./MobileNavMenu";

const NAV_LINKS = [
  { href: "/",          label: "Home"      },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/analytics", label: "Analytics" },
  { href: "/about",     label: "About"     },
];

const C = {
  bg:        "var(--bg)",
  bg1:       "var(--surface)",
  bg2:       "var(--surface)",
  border:    "var(--line)",
  borderHi:  "var(--line-strong)",
  borderGlow:"var(--line-strong)",
  text:      "var(--fg-muted)",
  textMid:   "var(--fg-muted)",
  textBright:"var(--fg)",
  green:     "var(--accent)",
  greenDim:  "var(--accent-hover)",
  greenFaint:"color-mix(in srgb, var(--accent) 6%, transparent)",
  greenGlow: "color-mix(in srgb, var(--accent) 18%, transparent)",
  cyan:      "var(--info)",
  purple:    "var(--chain-solana)",
  blue:      "var(--info)",
} as const;

const FONT = "'JetBrains Mono','Courier New',monospace";

function truncate(addr: string, head = 4, tail = 4) {
  return addr.length > head + tail + 2 ? `${addr.slice(0, head)}…${addr.slice(-tail)}` : addr;
}

export default function TerminalNavbar() {
  const pathname = usePathname() ?? "/";
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const { evmAddress: address, solanaAddress, suiAddress } = useWalletAuth();
  const { watchedWallets, scanAddress } = useWatchedWallets();

  // Wallet chips show EVERY wallet the pages are computing over — connected,
  // watched (Manage Wallets), or the pasted scan address — not just connected.
  // Previously watched/scanned wallets rendered "no wallet" here even while the
  // dashboard/analytics below were full of their positions.
  const CHAIN_COLOR: Record<string, string> = { evm: C.cyan, solana: C.purple, sui: C.blue };
  const CHAIN_LABEL: Record<string, string> = { evm: "EVM", solana: "SOL", sui: "SUI" };
  type ChipEntry = { chain: string; addr: string; kind: "connected" | "watched" | "scan" };
  const chips: ChipEntry[] = [];
  if (scanAddress) {
    // Scan mode overrides everything else app-wide; the bar mirrors that.
    chips.push({ chain: scanAddress.chain, addr: scanAddress.address, kind: "scan" });
  } else {
    if (address) chips.push({ chain: "evm", addr: address, kind: "connected" });
    if (solanaAddress) chips.push({ chain: "solana", addr: solanaAddress, kind: "connected" });
    if (suiAddress) chips.push({ chain: "sui", addr: suiAddress, kind: "connected" });
    for (const w of watchedWallets) {
      const dupe = chips.some((c) => c.chain === w.chain && c.addr.toLowerCase() === w.address.toLowerCase());
      if (!dupe) chips.push({ chain: w.chain, addr: w.address, kind: "watched" });
    }
  }
  const MAX_CHIPS = 4;
  const visibleChips = chips.slice(0, MAX_CHIPS);
  const overflowCount = chips.length - visibleChips.length;

  const isActive = (href: string) =>
    href === "/" ? pathname === "/"
    : href !== "#" && (pathname === href || pathname.startsWith(`${href}/`));

  const tabBase: CSSProperties = {
    display: "flex",
    alignItems: "center",
    padding: "0 22px",
    fontSize: 15,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: C.text,
    borderRight: `1px solid ${C.border}`,
    textDecoration: "none",
    transition: "color 0.15s, background 0.15s",
    position: "relative",
    fontFamily: FONT,
  };

  const tabActive: CSSProperties = {
    ...tabBase,
    color: C.textBright,
  };

  type ChipProps = { color: string; chain: string; addr: string };
  function Chip({ color, chain, addr }: ChipProps) {
    return (
      <button
        type="button"
        onClick={() => navigator.clipboard.writeText(addr)}
        title={`Copy ${chain} address`}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 10px",
          border: `1px solid ${C.border}`,
          background: C.bg2,
          cursor: "pointer",
          fontSize: 10,
          letterSpacing: "0.04em",
          fontFamily: FONT,
        }}
      >
        <span style={{ width: 5, height: 5, background: color, flexShrink: 0 }} />
        <span style={{ color: C.text, fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase" }}>
          {chain}
        </span>
        <span style={{ color: C.textMid }}>{truncate(addr)}</span>
      </button>
    );
  }

  return (
    <nav
      style={{
        height: 52,
        display: "flex",
        alignItems: "stretch",
        borderBottom: `1px solid ${C.border}`,
        background: "var(--overlay)",
        // Fixed positioning per user spec — sticky was reported as
        // not staying pinned. Pages that mount this component
        // compensate with paddingTop: 52 on their outer container so
        // the now-out-of-flow nav doesn't overlap their first row.
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        width: "100%",
        zIndex: 50,
        fontFamily: FONT,
      }}
    >
      {/* Logo block */}
      <div
        style={{
          padding: "0 28px",
          display: "flex",
          alignItems: "center",
          borderRight: `1px solid ${C.border}`,
          flexShrink: 0,
        }}
      >
        <Link
          href="/"
          style={{ textDecoration: "none", display: "flex", alignItems: "center", gap: 0 }}
        >
          <span style={{ fontSize: 20, fontWeight: 700, color: C.green, letterSpacing: "0.14em" }}>DEFI</span>
          <span style={{ color: C.borderGlow, fontWeight: 300, padding: "0 2px" }}>/</span>
          <span style={{ fontSize: 20, fontWeight: 700, color: C.textMid, letterSpacing: "0.14em" }}>DESH</span>
        </Link>
      </div>

      {/* Tabs */}
      <div className="term-nav-tabs" style={{ display: "flex" }}>
        {NAV_LINKS.map((l) => {
          const active = isActive(l.href);
          return (
            <Link
              key={l.label}
              href={l.href}
              style={active ? tabActive : tabBase}
            >
              {l.label}
              {active && (
                <span
                  style={{
                    position: "absolute",
                    bottom: -1,
                    left: 0,
                    right: 0,
                    height: 1,
                    background: C.green,
                    boxShadow: `0 0 8px ${C.greenGlow}`,
                  }}
                />
              )}
            </Link>
          );
        })}
      </div>

      {/* Wallet chips */}
      <div
        className="hidden md:flex"
        style={{
          alignItems: "center",
          gap: 6,
          padding: "0 20px",
          borderRight: `1px solid ${C.border}`,
        }}
      >
        {mounted && visibleChips.map((c) => (
          <Chip
            key={`${c.chain}:${c.addr}`}
            color={CHAIN_COLOR[c.chain] ?? C.text}
            chain={c.kind === "scan" ? `${CHAIN_LABEL[c.chain] ?? c.chain}·SCAN` : (CHAIN_LABEL[c.chain] ?? c.chain)}
            addr={c.addr}
          />
        ))}
        {mounted && overflowCount > 0 && (
          <span
            title={chips.slice(MAX_CHIPS).map((c) => `${CHAIN_LABEL[c.chain] ?? c.chain} ${c.addr}`).join("\n")}
            style={{ fontSize: 10, color: C.textMid, letterSpacing: "0.08em", padding: "5px 6px", border: `1px solid ${C.border}`, background: C.bg2 }}
          >
            +{overflowCount}
          </span>
        )}
        {mounted && chips.length === 0 && (
          <span style={{ fontSize: 10, color: C.text, letterSpacing: "0.08em" }}>
            no wallet
          </span>
        )}
      </div>

      <div style={{ flex: 1 }} />

      {/* LIVE status — matched pair: READ-ONLY badge and LIVE pill share
          identical container styling. Only differences are text content
          and the pulsing dot on ALL SYSTEMS NOMINAL. */}
      <div style={{ display: "flex", alignItems: "stretch", gap: 8 }}>
        <div
          className="term-nav-ro-badge"
          style={{
            display: "flex",
            alignItems: "center",
            margin: "10px 0",
            padding: "5px 12px",
            border: "0.5px solid var(--accent)",
            background: "var(--accent-surface)",
            borderRadius: 3,
            fontSize: 13,
            color: "var(--accent)",
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            whiteSpace: "nowrap",
          }}
        >
          ■ READ-ONLY · NON-CUSTODIAL
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            margin: "10px 16px 10px 0",
            padding: "5px 12px",
            border: "0.5px solid var(--accent)",
            background: "var(--accent-surface)",
            borderRadius: 3,
            fontSize: 13,
            color: "var(--accent)",
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            whiteSpace: "nowrap",
          }}
        >
          <span
            className="animate-pulse"
            style={{
              width: 6,
              height: 6,
              background: C.green,
              flexShrink: 0,
              display: "inline-block",
            }}
          />
          <span className="hidden sm:inline">All systems nominal</span>
          <span className="sm:hidden">LIVE</span>
        </div>
      </div>

      {/* Mobile-only hamburger + dropdown menu. Shared with TerminalNav
          and the homepage <nav> so all three nav variants expose the
          same mobile navigation. */}
      <MobileNavMenu />
    </nav>
  );
}
