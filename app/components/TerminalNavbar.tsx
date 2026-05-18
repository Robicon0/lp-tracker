"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type CSSProperties } from "react";
import { useAccount } from "wagmi";
import { useWalletAuth } from "../contexts/WalletAuthContext";
import MobileNavMenu from "./MobileNavMenu";

const NAV_LINKS = [
  { href: "/",          label: "Home"      },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/analytics", label: "Analytics" },
  { href: "/about",     label: "About"     },
];

const C = {
  bg:        "#050505",
  bg1:       "#090909",
  bg2:       "#0d0d0d",
  border:    "#1c1c1c",
  borderHi:  "#262626",
  borderGlow:"#2e2e2e",
  text:      "#a8a8a8",
  textMid:   "#b4b4b4",
  textBright:"#e8e8e8",
  green:     "#00ff41",
  greenDim:  "#00b82a",
  greenFaint:"rgba(0,255,65,0.06)",
  greenGlow: "rgba(0,255,65,0.18)",
  cyan:      "#00d4ff",
  purple:    "#9945ff",
  blue:      "#3d9fff",
} as const;

const FONT = "'JetBrains Mono','Courier New',monospace";

function truncate(addr: string, head = 4, tail = 4) {
  return addr.length > head + tail + 2 ? `${addr.slice(0, head)}…${addr.slice(-tail)}` : addr;
}

export default function TerminalNavbar() {
  const pathname = usePathname() ?? "/";
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const { address } = useAccount();
  const { solanaAddress, suiAddress } = useWalletAuth();

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
        background: "rgba(5,5,5,0.97)",
        position: "sticky",
        top: 0,
        zIndex: 10000,
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
        {mounted && address && (
          <Chip color={C.cyan} chain="EVM" addr={address} />
        )}
        {mounted && solanaAddress && (
          <Chip color={C.purple} chain="SOL" addr={solanaAddress} />
        )}
        {mounted && suiAddress && (
          <Chip color={C.blue} chain="SUI" addr={suiAddress} />
        )}
        {mounted && !address && !solanaAddress && !suiAddress && (
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
            border: "0.5px solid #00ff41",
            background: "#00ff4108",
            borderRadius: 3,
            fontSize: 13,
            color: "#00ff41",
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
            border: "0.5px solid #00ff41",
            background: "#00ff4108",
            borderRadius: 3,
            fontSize: 13,
            color: "#00ff41",
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
