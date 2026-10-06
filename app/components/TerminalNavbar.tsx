"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
import CalculatorMenu from "./CalculatorMenu";
import { useWalletAuth } from "../contexts/WalletAuthContext";
import { useWatchedWallets } from "../contexts/WatchedWalletsContext";
import MobileNavMenu from "./MobileNavMenu";
import { useWalletDisconnect } from "../hooks/useWalletDisconnect";
import type { WalletChain } from "../lib/walletDisconnectFlag";

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
  warn:      "var(--warn)",
  red:       "var(--neg)",
} as const;

const FONT = "'JetBrains Mono','Courier New',monospace";

function truncate(addr: string, head = 4, tail = 4) {
  return addr.length > head + tail + 2 ? `${addr.slice(0, head)}…${addr.slice(-tail)}` : addr;
}

export default function TerminalNavbar() {
  const pathname = usePathname() ?? "/";
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const { evmAddress: address, evmIdentitySource, solanaAddress, suiAddress } = useWalletAuth();
  const { watchedWallets, scanAddress, removeWallet } = useWatchedWallets();
  const { disconnectChain } = useWalletDisconnect();

  // Which chip's menu is open (key = `${chain}:${addr}`), or null. Clicking a
  // chip used to do nothing visible — it silently copied the address — so there
  // was no way to disconnect from the bar at all. Closes on outside click / Esc.
  const [openChip, setOpenChip] = useState<string | null>(null);
  const [copiedChip, setCopiedChip] = useState<string | null>(null);
  const chipsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!openChip) return;
    const onDown = (e: MouseEvent) => {
      if (chipsRef.current && !chipsRef.current.contains(e.target as Node)) setOpenChip(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpenChip(null); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [openChip]);

  // Wallet chips show EVERY wallet the pages are computing over — connected,
  // watched (Manage Wallets), or the pasted scan address — not just connected.
  // Previously watched/scanned wallets rendered "no wallet" here even while the
  // dashboard/analytics below were full of their positions.
  const CHAIN_COLOR: Record<string, string> = { evm: C.cyan, solana: C.purple, sui: C.blue };
  const CHAIN_LABEL: Record<string, string> = { evm: "EVM", solana: "SOL", sui: "SUI" };
  type ChipEntry = { chain: string; addr: string; kind: "connected" | "watched" | "scan"; restored?: boolean };
  const chips: ChipEntry[] = [];
  if (scanAddress) {
    // Scan mode overrides everything else app-wide; the bar mirrors that.
    chips.push({ chain: scanAddress.chain, addr: scanAddress.address, kind: "scan" });
  } else {
    // A RESTORED EVM address is a cached best guess and may be STALE — the
    // confirmed 2026-08-02 bug showed a stale address as "connected" while
    // every position query ran against the wrong wallet. Mark it so the bar
    // never overstates what we know.
    if (address) chips.push({ chain: "evm", addr: address, kind: "connected", restored: evmIdentitySource === "restored" });
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

  const menuItem: CSSProperties = {
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "8px 12px",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    fontSize: 11,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    fontFamily: FONT,
    color: C.textBright,
    whiteSpace: "nowrap",
  };

  // A render function, not a nested component: a component declared inside
  // this one would be a NEW type every render and remount, dropping focus.
  const renderChip = (c: ChipEntry) => {
    const key = `${c.chain}:${c.addr}`;
    const color = CHAIN_COLOR[c.chain] ?? C.text;
    const label = CHAIN_LABEL[c.chain] ?? c.chain;
    const chain = c.kind === "scan" ? `${label}·SCAN` : label;
    const restored = c.restored;
    const open = openChip === key;
    return (
      <div key={key} style={{ position: "relative" }}>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpenChip(open ? null : key)}
          title={restored
            ? `${c.addr}\n\nLAST USED address — your wallet is locked or not connected, so this may not be your current account. Unlock it and this updates automatically.`
            : `${chain} wallet options`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 10px",
            border: restored ? `1px dashed ${C.warn}` : `1px solid ${open ? C.borderHi : C.border}`,
            background: restored ? "transparent" : C.bg2,
            cursor: "pointer",
            fontSize: 10,
            letterSpacing: "0.04em",
            fontFamily: FONT,
          }}
        >
          <span style={{ width: 5, height: 5, background: restored ? "transparent" : color, border: restored ? `1px solid ${color}` : undefined, flexShrink: 0 }} />
          <span style={{ color: C.text, fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase" }}>
            {chain}
          </span>
          <span style={{ color: C.textMid }}>{truncate(c.addr)}</span>
          {restored && (
            <span style={{ color: C.warn, fontSize: 8, letterSpacing: "0.1em" }}>LAST USED</span>
          )}
        </button>
        {open && (
          <div
            role="menu"
            aria-label={`${chain} wallet options`}
            style={{
              position: "absolute",
              top: "calc(100% + 6px)",
              left: 0,
              minWidth: 170,
              background: C.bg,
              border: `1px solid ${C.borderHi}`,
              boxShadow: "var(--shadow-md)",
              zIndex: 60,
            }}
          >
            <button
              type="button"
              role="menuitem"
              style={menuItem}
              onClick={() => {
                void navigator.clipboard?.writeText(c.addr);
                setCopiedChip(key);
                setTimeout(() => setCopiedChip((k) => (k === key ? null : k)), 1500);
              }}
            >
              {copiedChip === key ? "Copied ✓" : "Copy address"}
            </button>
            {c.kind === "connected" && (
              <button
                type="button"
                role="menuitem"
                style={{ ...menuItem, color: C.red, borderTop: `1px solid ${C.border}` }}
                onClick={() => {
                  disconnectChain(c.chain as WalletChain);
                  setOpenChip(null);
                }}
              >
                Disconnect {label} wallet
              </button>
            )}
            {c.kind === "watched" && (
              <button
                type="button"
                role="menuitem"
                style={{ ...menuItem, color: C.red, borderTop: `1px solid ${C.border}` }}
                onClick={() => {
                  removeWallet(c.addr, c.chain as WalletChain);
                  setOpenChip(null);
                }}
              >
                Remove watched wallet
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <nav
      style={{
        height: 52,
        display: "flex",
        alignItems: "stretch",
        borderBottom: `1px solid ${C.border}`,
        // --nav-surface, NOT --overlay. --overlay is a modal SCRIM (0.72/0.78
        // alpha) whose whole job is letting the page show through; behind a
        // FIXED navbar that is a defect. With no backdrop-filter to soften it,
        // the dashboard's portfolio value and stat tiles read straight through
        // the bar while scrolling under it — the reported "text collides with
        // the navbar" bug. Reproduced by scrolling to y=260 and hit-testing the
        // 0–52px band: section.anim-fade["// total_portfolio_value"] came back.
        background: "var(--nav-surface)",
        // The blur is what keeps the depth cue the translucency was there for,
        // while making anything behind it illegible rather than merely faint.
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
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
            <Fragment key={l.label}>
              <Link href={l.href} style={active ? tabActive : tabBase}>
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
              {/* Calculator sits immediately after Analytics rather than after
                  the whole list, which is why this renders inside the map. */}
              {l.href === "/analytics" && <CalculatorMenu variant="tab" />}
            </Fragment>
          );
        })}
      </div>

      {/* Wallet chips */}
      <div
        ref={chipsRef}
        className="hidden md:flex"
        style={{
          alignItems: "center",
          gap: 6,
          padding: "0 20px",
          borderRight: `1px solid ${C.border}`,
        }}
      >
        {mounted && visibleChips.map(renderChip)}
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
