"use client";

import type { CSSProperties } from "react";
import Link from "next/link";
import type { AerodromePosition } from "../lib/aerodrome";
import type { WatchedWalletChain } from "../contexts/WatchedWalletsContext";

const C = {
  bg:        "#050505",
  bg1:       "#090909",
  bg2:       "#0d0d0d",
  bg4:       "#171717",
  border:    "#1c1c1c",
  borderHi:  "#262626",
  text:      "#8a8a8a",
  textMid:   "#b4b4b4",
  green:     "#00ff41",
  greenDim:  "#00b82a",
  greenFaint:"rgba(0,255,65,0.06)",
  cyan:      "#00d4ff",
  purple:    "#9945ff",
  blue:      "#3d9fff",
} as const;

const FONT = "'JetBrains Mono','Courier New',monospace";

export type NavSection = "overview" | "positions" | "cashflow" | "alerts";

const NAV_ITEMS: { id: NavSection; label: string; icon: string; badgeKey?: "positions" | "alerts" }[] = [
  { id: "overview",  label: "Overview",  icon: "◇", badgeKey: "positions" },
  { id: "positions", label: "Positions", icon: "▤" },
  { id: "cashflow",  label: "Cash Flow", icon: "≋" },
  { id: "alerts",    label: "Alerts",    icon: "△", badgeKey: "alerts" },
];

const PROTOCOL_LIST: { name: string; matchKeys: string[]; type: "lp" | "lending" }[] = [
  { name: "Uniswap V3", matchKeys: ["Uniswap"],   type: "lp" },
  { name: "Aave V3",    matchKeys: ["Aave"],      type: "lending" },
  { name: "Morpho",     matchKeys: ["Morpho"],    type: "lending" },
  { name: "Aerodrome",  matchKeys: ["Aerodrome"], type: "lp" },
  { name: "Kamino",     matchKeys: ["Kamino"],    type: "lending" },
  { name: "Orca",       matchKeys: ["Orca"],      type: "lp" },
  { name: "Cetus",      matchKeys: ["Cetus"],     type: "lp" },
  { name: "Bluefin",    matchKeys: ["Bluefin"],   type: "lp" },
];

interface Props {
  activeSection: NavSection;
  onSectionChange: (id: NavSection) => void;
  positions: AerodromePosition[];
  lendingProtocolNames: string[];
  evmAddr?: string | null;
  solAddr?: string | null;
  suiAddr?: string | null;
  watchedWallets: { address: string; chain: WatchedWalletChain; label?: string }[];
  onAddWallet: () => void;
}

export default function DashboardSidebar({
  activeSection,
  onSectionChange,
  positions,
  lendingProtocolNames,
  evmAddr,
  solAddr,
  suiAddr,
  watchedWallets,
  onAddWallet,
}: Props) {
  const lpProtocolPresence = (keys: string[]) =>
    positions.some((p) => p.value > 0 && keys.some((k) => p.protocol.includes(k)));
  const lendingProtocolPresence = (keys: string[]) =>
    lendingProtocolNames.some((n) => keys.some((k) => n.includes(k)));

  const positionsCount = positions.filter((p) => p.value > 0).length;
  const badges: Record<"positions" | "alerts", string | null> = {
    positions: positionsCount > 0 ? String(positionsCount) : null,
    alerts: null,
  };

  const sectionWrap: CSSProperties = {
    padding: "20px 0 12px",
    borderBottom: `1px solid ${C.border}`,
  };

  const labelStyle: CSSProperties = {
    fontSize: 8,
    letterSpacing: "0.22em",
    textTransform: "uppercase",
    color: C.text,
    padding: "0 18px 10px",
    opacity: 0.5,
  };

  const itemBase: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 9,
    padding: "7px 18px",
    fontSize: 11,
    color: C.text,
    cursor: "pointer",
    textDecoration: "none",
    transition: "color 0.12s, background 0.12s, border-color 0.12s",
    borderLeft: "2px solid transparent",
    letterSpacing: "0.02em",
    fontFamily: FONT,
    background: "transparent",
    width: "100%",
    textAlign: "left" as const,
    boxSizing: "border-box" as const,
  };

  const itemActive: CSSProperties = {
    ...itemBase,
    color: C.green,
    background: C.greenFaint,
    borderLeftColor: C.green,
    textShadow: "0 0 12px rgba(0,255,65,0.4)",
  };

  const iconStyle: CSSProperties = {
    fontSize: 10,
    width: 14,
    textAlign: "center",
    flexShrink: 0,
  };

  const badgeStyle = (active: boolean): CSSProperties => ({
    marginLeft: "auto",
    fontSize: 8,
    background: active ? C.greenFaint : C.bg4,
    border: `1px solid ${active ? C.greenDim : C.border}`,
    padding: "1px 6px",
    color: active ? C.green : C.text,
  });

  const walletColor = (chain: WatchedWalletChain | "EVM" | "SOL" | "SUI"): string => {
    switch (chain) {
      case "evm":
      case "EVM":
        return C.cyan;
      case "solana":
      case "SOL":
        return C.purple;
      case "sui":
      case "SUI":
        return C.blue;
      default:
        return C.text;
    }
  };

  return (
    <aside
      className="hidden md:flex"
      style={{
        flexDirection: "column",
        position: "sticky",
        top: 52,
        alignSelf: "flex-start",
        width: 192,
        flexShrink: 0,
        height: "calc(100vh - 52px)",
        overflowY: "auto",
        background: C.bg1,
        borderRight: `1px solid ${C.border}`,
        fontFamily: FONT,
      }}
    >
      {/* DASHBOARD nav */}
      <div style={sectionWrap}>
        <div style={labelStyle}>Dashboard</div>
        {NAV_ITEMS.map((item) => {
          const active = activeSection === item.id;
          const badge = item.badgeKey ? badges[item.badgeKey] : null;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSectionChange(item.id)}
              style={active ? itemActive : itemBase}
              onMouseEnter={(e) => {
                if (!active) {
                  e.currentTarget.style.color = C.textMid;
                  e.currentTarget.style.background = C.bg2;
                }
              }}
              onMouseLeave={(e) => {
                if (!active) {
                  e.currentTarget.style.color = C.text;
                  e.currentTarget.style.background = "transparent";
                }
              }}
            >
              <span style={iconStyle}>{item.icon}</span>
              {item.label}
              {badge && <span style={badgeStyle(active)}>{badge}</span>}
            </button>
          );
        })}
      </div>

      {/* PROTOCOLS */}
      <div style={sectionWrap}>
        <div style={labelStyle}>Protocols</div>
        {PROTOCOL_LIST.map((p) => {
          const live =
            p.type === "lp"
              ? lpProtocolPresence(p.matchKeys)
              : lendingProtocolPresence(p.matchKeys);
          return (
            <div
              key={p.name}
              style={{
                ...itemBase,
                cursor: "default",
                color: live ? C.textMid : C.text,
                opacity: live ? 1 : 0.6,
              }}
            >
              <span
                style={{
                  ...iconStyle,
                  color: live ? C.green : C.text,
                  opacity: live ? 1 : 0.4,
                }}
              >
                {live ? "●" : "·"}
              </span>
              {p.name}
            </div>
          );
        })}
      </div>

      {/* WALLETS */}
      <div style={sectionWrap}>
        <div style={labelStyle}>Wallets</div>

        {/* Wallet Balances link — navigates to /dashboard/tokens */}
        <Link
          href="/dashboard/tokens"
          style={{
            ...itemBase,
            color: C.cyan,
            opacity: 0.85,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = C.green;
            e.currentTarget.style.background = C.greenFaint;
            e.currentTarget.style.opacity = "1";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = C.cyan;
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.opacity = "0.85";
          }}
        >
          <span style={iconStyle}>◫</span>
          Wallet Balances
        </Link>

        {evmAddr && (
          <WalletItem color={walletColor("EVM")} chain="EVM" />
        )}
        {solAddr && (
          <WalletItem color={walletColor("SOL")} chain="SOL" />
        )}
        {suiAddr && (
          <WalletItem color={walletColor("SUI")} chain="SUI" />
        )}
        {watchedWallets.map((w) => (
          <WalletItem
            key={w.address}
            color={walletColor(w.chain)}
            chain={`${w.chain.toUpperCase()}${w.label ? ` · ${w.label}` : ""}`}
          />
        ))}

        <button
          type="button"
          onClick={onAddWallet}
          style={{
            ...itemBase,
            opacity: 0.6,
            cursor: "pointer",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = C.green;
            e.currentTarget.style.opacity = "1";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = C.text;
            e.currentTarget.style.opacity = "0.6";
          }}
        >
          <span style={iconStyle}>+</span>
          Add Wallet
        </button>
      </div>
    </aside>
  );
}

function WalletItem({ color, chain }: { color: string; chain: string }) {
  const itemStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 9,
    padding: "7px 18px",
    fontSize: 11,
    color: C.text,
    textDecoration: "none",
    letterSpacing: "0.02em",
    fontFamily: FONT,
    borderLeft: "2px solid transparent",
    cursor: "default",
  };
  return (
    <div style={itemStyle}>
      <span style={{ fontSize: 10, width: 14, textAlign: "center", color, opacity: 1, flexShrink: 0 }}>
        ◆
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {chain}
      </span>
    </div>
  );
}
