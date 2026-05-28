"use client";

import type { CSSProperties } from "react";

const C = {
  bg:        "#050505",
  bg1:       "#060606",
  bg2:       "#0d0d0d",
  bg4:       "#171717",
  border:    "#1c1c1c",
  borderHi:  "#262626",
  text:      "#a8a8a8",
  textMid:   "#b4b4b4",
  green:     "#00ff41",
  greenDim:  "#00b82a",
  greenFaint:"rgba(0,255,65,0.06)",
  cyan:      "#00d4ff",
  purple:    "#9945ff",
  blue:      "#3d9fff",
  amber:     "#ffaa00",
} as const;

const FONT = "'JetBrains Mono','Courier New',monospace";

export type AnalyticsSection =
  | "overview"
  | "fee-income"
  | "lp-pnl"
  | "performance"
  | "exposure";

const NAV_ITEMS: { id: AnalyticsSection; label: string; icon: string }[] = [
  { id: "overview",    label: "Overview",    icon: "◇" },
  { id: "fee-income",  label: "Fee Income",  icon: "$" },
  { id: "lp-pnl",      label: "LP P&L",      icon: "≡" },
  { id: "performance", label: "Performance", icon: "▤" },
  { id: "exposure",    label: "Exposure",    icon: "◎" },
];

const CHAIN_LIST: { name: string; color: string }[] = [
  { name: "Ethereum", color: C.cyan },
  { name: "Base",     color: C.blue },
  { name: "Arbitrum", color: C.green },
  { name: "Optimism", color: "#ff0420" },
  { name: "Polygon",  color: C.purple },
  { name: "Solana",   color: C.purple },
  { name: "Sui",      color: C.blue },
  { name: "HyperEVM", color: "#00d4aa" },
  { name: "BNB Chain",color: C.amber },
];

const PROTOCOL_LIST = [
  "Aerodrome",
  "Uniswap V3",
  "Velodrome",
  "Orca",
  "Raydium",
  "Cetus",
  "Bluefin",
  "Momentum",
  "AAVE V3",
  "Suilend",
  "Kamino",
  "Jupiter Lend",
];

interface Props {
  activeSection: AnalyticsSection;
  onSectionChange: (id: AnalyticsSection) => void;
  activeProtocols: Set<string>;
  activeChains: Set<string>;
  // Filter state — chains/protocols the user has selected. Empty sets =
  // no filter = show everything (page looks identical to pre-filter).
  selectedChains: Set<string>;
  selectedProtocols: Set<string>;
  onChainToggle: (chain: string) => void;
  onProtocolToggle: (protocol: string) => void;
  onClearFilters: () => void;
}

export default function AnalyticsSidebar({
  activeSection,
  onSectionChange,
  activeProtocols,
  activeChains,
  selectedChains,
  selectedProtocols,
  onChainToggle,
  onProtocolToggle,
  onClearFilters,
}: Props) {
  const filterActive = selectedChains.size > 0 || selectedProtocols.size > 0;
  const sectionWrap: CSSProperties = {
    padding: "20px 0 12px",
    borderBottom: `1px solid ${C.border}`,
  };
  const labelStyle: CSSProperties = {
    fontSize: 11,
    letterSpacing: "0.22em",
    textTransform: "uppercase",
    color: C.text,
    padding: "0 20px 14px",
    opacity: 0.5,
  };
  const itemBase: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "9px 20px",
    fontSize: 15.5,
    color: C.textMid,
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
    fontWeight: 700,
  };
  const iconStyle: CSSProperties = {
    fontSize: 14,
    width: 14,
    textAlign: "center",
    flexShrink: 0,
    color: C.text,
  };

  return (
    <aside
      className="hidden md:flex sidebar-no-scrollbar"
      style={{
        flexDirection: "column",
        // Fixed positioning per user spec. <main> compensates with
        // md:ml-[200px] to leave room since fixed takes the sidebar
        // OUT of the flex flow.
        position: "fixed",
        top: 52,
        left: 0,
        width: 200,
        height: "calc(100vh - 52px)",
        overflowY: "auto",
        zIndex: 10,
        background: C.bg1,
        borderRight: `1px solid ${C.border}`,
        fontFamily: FONT,
      }}
    >
      {/* ANALYTICS nav */}
      <div style={sectionWrap}>
        <div style={labelStyle}>Analytics</div>
        {NAV_ITEMS.map((item) => {
          const active = activeSection === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSectionChange(item.id)}
              style={active ? itemActive : itemBase}
              onMouseEnter={(e) => {
                if (!active) {
                  e.currentTarget.style.color = "#e8e8e8";
                  e.currentTarget.style.background = C.bg2;
                }
              }}
              onMouseLeave={(e) => {
                if (!active) {
                  e.currentTarget.style.color = C.textMid;
                  e.currentTarget.style.background = "transparent";
                }
              }}
            >
              <span
                style={{ ...iconStyle, color: active ? C.green : C.text }}
              >
                {item.icon}
              </span>
              {item.label}
            </button>
          );
        })}
      </div>

      {/* CLEAR ALL — only when at least one chain/protocol filter is active */}
      {filterActive && (
        <div style={{ padding: "12px 0", borderBottom: `1px solid ${C.border}` }}>
          <button
            type="button"
            onClick={onClearFilters}
            style={{ ...itemBase, color: C.amber, fontWeight: 700 }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,170,0,0.08)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            <span style={{ ...iconStyle, color: C.amber }}>✕</span>
            Clear All
          </button>
        </div>
      )}

      {/* PROTOCOLS — interactive multi-select filters */}
      <div style={sectionWrap}>
        <div style={labelStyle}>Protocols</div>
        {PROTOCOL_LIST.map((p) => {
          const live = activeProtocols.has(p);
          const selected = selectedProtocols.has(p);

          // Unavailable (not in wallet) — dimmed, non-clickable (unchanged).
          if (!live) {
            return (
              <div
                key={p}
                style={{ ...itemBase, cursor: "default", color: C.text, opacity: 0.55 }}
              >
                <span style={{ width: 3, height: 3, background: C.text, flexShrink: 0, marginLeft: 5, marginRight: 5 }} />
                {p}
              </div>
            );
          }

          return (
            <button
              key={p}
              type="button"
              onClick={() => onProtocolToggle(p)}
              style={selected ? { ...itemActive } : { ...itemBase }}
              onMouseEnter={(e) => {
                if (!selected) { e.currentTarget.style.color = "#e8e8e8"; e.currentTarget.style.background = C.bg2; }
              }}
              onMouseLeave={(e) => {
                if (!selected) { e.currentTarget.style.color = C.textMid; e.currentTarget.style.background = "transparent"; }
              }}
            >
              <span
                style={{
                  width: 3,
                  height: 3,
                  background: C.green,
                  flexShrink: 0,
                  marginLeft: 5,
                  marginRight: 5,
                  boxShadow: selected ? `0 0 6px ${C.green}` : "none",
                }}
              />
              {p}
            </button>
          );
        })}
      </div>

      {/* CHAINS — interactive multi-select filters */}
      <div style={{ ...sectionWrap, borderBottom: "none" }}>
        <div style={labelStyle}>Chains</div>
        {CHAIN_LIST.map((ch) => {
          const live = activeChains.has(ch.name);
          const selected = selectedChains.has(ch.name);

          // Unavailable (not in wallet) — dimmed, non-clickable (unchanged).
          if (!live) {
            return (
              <div
                key={ch.name}
                style={{ ...itemBase, cursor: "default", color: C.text, opacity: 0.55 }}
              >
                <span style={{ width: 7, height: 7, background: ch.color, flexShrink: 0, boxShadow: "none", opacity: 0.35 }} />
                {ch.name}
              </div>
            );
          }

          return (
            <button
              key={ch.name}
              type="button"
              onClick={() => onChainToggle(ch.name)}
              style={selected ? { ...itemActive } : { ...itemBase }}
              onMouseEnter={(e) => {
                if (!selected) { e.currentTarget.style.color = "#e8e8e8"; e.currentTarget.style.background = C.bg2; }
              }}
              onMouseLeave={(e) => {
                if (!selected) { e.currentTarget.style.color = C.textMid; e.currentTarget.style.background = "transparent"; }
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  background: ch.color,
                  flexShrink: 0,
                  boxShadow: selected ? `0 0 8px ${ch.color}` : `0 0 4px ${ch.color}88`,
                }}
              />
              {ch.name}
            </button>
          );
        })}
      </div>
    </aside>
  );
}
