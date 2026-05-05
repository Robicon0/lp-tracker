"use client";

import type { CSSProperties } from "react";
import type { AerodromePosition } from "../lib/aerodrome";
import type { WatchedWalletChain } from "../contexts/WatchedWalletsContext";

const C = {
  bg: "#000000",
  card: "#090909",
  border: "#1c1c1c",
  green: "#00ff41",
  greenSoft: "rgba(0,255,65,0.08)",
  text: "#e8e8e8",
  textDim: "#c8c8c8",
  muted: "#7a7a7a",
  mute2: "#555555",
  mute3: "#333333",
} as const;

export type NavSection = "overview" | "positions" | "cashflow" | "alerts";

const NAV_ITEMS: { id: NavSection; label: string }[] = [
  { id: "overview",  label: "Overview"  },
  { id: "positions", label: "Positions" },
  { id: "cashflow",  label: "Cash Flow" },
  { id: "alerts",    label: "Alerts"    },
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

function truncate(addr: string, head = 6, tail = 4) {
  return addr.length > head + tail + 2 ? `${addr.slice(0, head)}…${addr.slice(-tail)}` : addr;
}

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

  const sectionLabelStyle: CSSProperties = {
    fontSize: 9,
    letterSpacing: "0.2em",
    textTransform: "uppercase",
    color: C.mute2,
    marginBottom: 10,
    display: "flex",
    alignItems: "center",
    gap: 8,
  };

  return (
    <aside
      className="hidden md:flex"
      style={{
        flexDirection: "column",
        position: "sticky",
        top: 52,
        alignSelf: "flex-start",
        width: 240,
        flexShrink: 0,
        height: "calc(100vh - 52px)",
        overflowY: "auto",
        background: C.bg,
        borderRight: `1px solid ${C.border}`,
        fontFamily: "var(--font-jetbrains-mono), monospace",
        padding: "20px 16px 28px",
        gap: 24,
      }}
    >
      {/* NAVIGATION */}
      <div>
        <div style={sectionLabelStyle}>
          <span style={{ color: C.green }}>//</span>
          <span>Navigation</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {NAV_ITEMS.map((item) => {
            const active = activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSectionChange(item.id)}
                style={{
                  textAlign: "left",
                  padding: "8px 10px",
                  border: "none",
                  background: active ? C.greenSoft : "transparent",
                  borderLeft: `2px solid ${active ? C.green : "transparent"}`,
                  color: active ? C.green : C.textDim,
                  fontSize: 12,
                  fontFamily: "var(--font-jetbrains-mono), monospace",
                  letterSpacing: "0.06em",
                  cursor: "pointer",
                  transition: "background 0.12s, color 0.12s, border-color 0.12s",
                }}
                onMouseEnter={(e) => {
                  if (!active) e.currentTarget.style.color = C.green;
                }}
                onMouseLeave={(e) => {
                  if (!active) e.currentTarget.style.color = C.textDim;
                }}
              >
                <span style={{ color: active ? C.green : C.mute2, marginRight: 8 }}>▸</span>
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* PROTOCOLS */}
      <div>
        <div style={sectionLabelStyle}>
          <span style={{ color: C.green }}>//</span>
          <span>Protocols</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {PROTOCOL_LIST.map((p) => {
            const live =
              p.type === "lp"
                ? lpProtocolPresence(p.matchKeys)
                : lendingProtocolPresence(p.matchKeys);
            return (
              <div
                key={p.name}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "6px 10px",
                  fontSize: 11,
                  color: live ? C.text : C.mute2,
                  letterSpacing: "0.04em",
                }}
              >
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      background: live ? C.green : "transparent",
                      border: live ? "none" : `1px solid rgba(0,255,65,0.25)`,
                      display: "inline-block",
                      boxSizing: "border-box",
                    }}
                  />
                  {p.name}
                </span>
                <span style={{ fontSize: 8, color: C.mute2, letterSpacing: "0.16em" }}>
                  {p.type === "lp" ? "LP" : "LEND"}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* WALLETS */}
      <div>
        <div style={sectionLabelStyle}>
          <span style={{ color: C.green }}>//</span>
          <span>Wallets</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <ChainBucket color="#00e5ff" label="EVM" addr={evmAddr ?? null}
            watched={watchedWallets.filter((w) => w.chain === "evm")} />
          <ChainBucket color="#9945ff" label="SOL" addr={solAddr ?? null}
            watched={watchedWallets.filter((w) => w.chain === "solana")} />
          <ChainBucket color="#4da2ff" label="SUI" addr={suiAddr ?? null}
            watched={watchedWallets.filter((w) => w.chain === "sui")} />

          <button
            type="button"
            onClick={onAddWallet}
            style={{
              marginTop: 4,
              background: C.greenSoft,
              border: `1px solid ${C.green}`,
              color: C.green,
              padding: "8px 10px",
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              cursor: "pointer",
              fontFamily: "var(--font-jetbrains-mono), monospace",
              textAlign: "left",
            }}
          >
            + Add Wallet
          </button>
        </div>
      </div>
    </aside>
  );
}

function ChainBucket({
  color,
  label,
  addr,
  watched,
}: {
  color: string;
  label: string;
  addr: string | null;
  watched: { address: string; label?: string }[];
}) {
  return (
    <div
      style={{
        background: C.card,
        border: `1px solid ${C.border}`,
        padding: "8px 10px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: addr || watched.length ? 6 : 0,
        }}
      >
        <span
          style={{
            fontSize: 9,
            color,
            fontWeight: 700,
            letterSpacing: "0.16em",
            border: `1px solid ${color}`,
            padding: "1px 5px",
          }}
        >
          {label}
        </span>
        {!addr && watched.length === 0 && (
          <span style={{ fontSize: 10, color: C.mute2, letterSpacing: "0.06em" }}>
            not connected
          </span>
        )}
      </div>

      {addr && (
        <div
          style={{
            fontSize: 10,
            color: C.textDim,
            fontFamily: "var(--font-jetbrains-mono), monospace",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 6,
          }}
        >
          <span>{truncate(addr)}</span>
          <button
            type="button"
            onClick={() => navigator.clipboard.writeText(addr)}
            title="Copy"
            style={{
              background: "none",
              border: "none",
              color: C.mute2,
              cursor: "pointer",
              padding: 0,
              fontSize: 11,
            }}
          >
            ⧉
          </button>
        </div>
      )}

      {watched.map((w) => (
        <div
          key={w.address}
          style={{
            fontSize: 10,
            color: C.muted,
            fontFamily: "var(--font-jetbrains-mono), monospace",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 6,
            marginTop: 4,
          }}
        >
          <span>
            <span style={{ color: C.mute2, marginRight: 4 }}>watched</span>
            {truncate(w.address)}
          </span>
          <button
            type="button"
            onClick={() => navigator.clipboard.writeText(w.address)}
            title="Copy"
            style={{
              background: "none",
              border: "none",
              color: C.mute2,
              cursor: "pointer",
              padding: 0,
              fontSize: 11,
            }}
          >
            ⧉
          </button>
        </div>
      ))}
    </div>
  );
}
