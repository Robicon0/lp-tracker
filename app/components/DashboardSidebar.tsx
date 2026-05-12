"use client";

import { useState, useEffect, useRef, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import type { WalletName } from "@solana/wallet-adapter-base";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { useWalletAuth } from "../contexts/WalletAuthContext";
import { setDisconnected } from "../lib/walletDisconnectFlag";
import type { AerodromePosition } from "../lib/aerodrome";
import type { WatchedWalletChain } from "../contexts/WatchedWalletsContext";

const C = {
  bg:        "#050505",
  bg1:       "#090909",
  bg2:       "#0d0d0d",
  bg4:       "#171717",
  border:    "#1c1c1c",
  borderHi:  "#262626",
  text:      "#a0a0a0",
  textMid:   "#aaaaaa",
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
  // ── Solana wallet connect — mirrors app/Navbar.tsx exactly ──
  // Adapter used ONLY for mechanics (select / connect / disconnect / wallet list).
  // Never read `connected` or `publicKey` for display — a locked Phantom wallet
  // keeps those truthy via Wallet Standard silent reconnect. Source of truth for
  // display is `solAddr` (from WalletAuthContext, passed in as a prop).
  const {
    wallet: currentSolanaWallet,
    select: solanaSelect,
    connect: connectSolana,
    disconnect: disconnectSolana,
    connected: adapterSolanaConnected,
    publicKey: adapterPublicKey,
    wallets: solanaWallets,
  } = useWallet();
  const { setSolanaAddress } = useWalletAuth();
  const [showSolanaModal, setShowSolanaModal] = useState(false);
  const awaitingSolanaConnect = useRef(false);

  useEffect(() => {
    if (awaitingSolanaConnect.current && adapterSolanaConnected && adapterPublicKey) {
      setSolanaAddress(adapterPublicKey.toBase58());
      awaitingSolanaConnect.current = false;
    }
  }, [adapterSolanaConnected, adapterPublicKey, setSolanaAddress]);

  const handleSolanaConnect = async (walletName: string) => {
    setShowSolanaModal(false);
    try {
      // Fast path: adapter already connected to this wallet (autoConnect / silent reconnect).
      // connectSolana() would throw "Wallet already connected" and the useEffect above
      // wouldn't fire (deps unchanged). Set directly.
      if (
        adapterSolanaConnected &&
        adapterPublicKey &&
        currentSolanaWallet?.adapter.name === walletName
      ) {
        setSolanaAddress(adapterPublicKey.toBase58());
        return;
      }
      solanaSelect(walletName as WalletName);
      awaitingSolanaConnect.current = true;
      await connectSolana();
    } catch (err) {
      if (adapterSolanaConnected && adapterPublicKey) {
        setSolanaAddress(adapterPublicKey.toBase58());
      } else {
        console.error("Solana connect error:", err);
      }
      awaitingSolanaConnect.current = false;
    }
  };

  const handleSolanaDisconnect = () => {
    setDisconnected("solana");
    setSolanaAddress(null);
    if (typeof window !== "undefined") localStorage.removeItem("defidesh-solana-addr");
    disconnectSolana();
  };

  // Filter to genuine Solana wallets only. MetaMask now registers itself as a
  // Wallet Standard Solana wallet via its Solana Snap, but it's an EVM wallet
  // and must never appear in this picker.
  const installedSolanaWallets = solanaWallets.filter(
    (w) =>
      w.readyState === WalletReadyState.Installed &&
      !w.adapter.name.toLowerCase().includes("metamask"),
  );

  const truncateAddr = (a: string) => a.slice(0, 4) + "…" + a.slice(-4);

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
    fontSize: 10,
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
    fontSize: 14,
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
    fontSize: 12,
    width: 14,
    textAlign: "center",
    flexShrink: 0,
  };

  const badgeStyle = (active: boolean): CSSProperties => ({
    marginLeft: "auto",
    fontSize: 10,
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
        {solAddr ? (
          // Connected: clicking the row disconnects (matches Navbar.tsx pattern)
          <button
            type="button"
            onClick={handleSolanaDisconnect}
            title="Click to disconnect Solana"
            style={{
              ...itemBase,
              cursor: "pointer",
              color: C.purple,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = C.bg2;
              e.currentTarget.style.color = C.green;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = C.purple;
            }}
          >
            <span style={{ ...iconStyle, color: C.purple, opacity: 1 }}>◆</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              SOL · {truncateAddr(solAddr)}
            </span>
          </button>
        ) : (
          // Not connected: shows Connect Solana button → opens wallet picker
          <button
            type="button"
            onClick={() => setShowSolanaModal(true)}
            style={{
              ...itemBase,
              cursor: "pointer",
              color: C.purple,
              opacity: 0.85,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(153,69,255,0.06)";
              e.currentTarget.style.opacity = "1";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.opacity = "0.85";
            }}
          >
            <span style={{ ...iconStyle, color: C.purple, opacity: 1 }}>◆</span>
            Connect Solana
          </button>
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

      {/* Solana wallet picker — rendered into document.body via createPortal
          so it escapes the <aside>'s sticky/overflow context. Without the
          portal, the modal is clipped by any ancestor that creates a CSS
          containing block, leaving [X] and the wallet buttons unclickable.
          zIndex 100000 sits above TerminalNavbar (10000) and the
          FloatingFeedback launcher (99998). */}
      {showSolanaModal && typeof document !== "undefined" && createPortal(
        <div
          onClick={() => setShowSolanaModal(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.7)",
            zIndex: 100000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: FONT,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 360,
              maxWidth: "90vw",
              background: C.bg,
              border: `1px solid ${C.purple}`,
              boxShadow: "0 0 40px rgba(153,69,255,0.18)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "12px 16px",
                borderBottom: `1px solid ${C.purple}`,
              }}
            >
              <span style={{ color: C.purple, fontSize: 14, letterSpacing: "0.12em", fontWeight: 700 }}>
                CONNECT_SOLANA_WALLET
              </span>
              <button
                type="button"
                onClick={() => setShowSolanaModal(false)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: C.purple,
                  fontSize: 14,
                  letterSpacing: "0.2em",
                  cursor: "pointer",
                  fontFamily: FONT,
                }}
              >
                [X]
              </button>
            </div>
            <div style={{ padding: 16 }}>
              {installedSolanaWallets.length === 0 ? (
                <p style={{ fontSize: 15, color: C.text, lineHeight: 1.5 }}>
                  No Solana wallet detected. Install Phantom, Backpack, or Solflare.
                </p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {installedSolanaWallets.map((w) => (
                    <button
                      type="button"
                      key={w.adapter.name}
                      onClick={() => handleSolanaConnect(w.adapter.name)}
                      style={{
                        width: "100%",
                        textAlign: "left",
                        padding: "10px 14px",
                        background: "transparent",
                        border: `1px solid ${C.borderHi}`,
                        color: C.textMid,
                        fontFamily: FONT,
                        fontSize: 15,
                        letterSpacing: "0.04em",
                        cursor: "pointer",
                        transition: "all 0.12s",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.borderColor = C.purple;
                        e.currentTarget.style.background = "rgba(153,69,255,0.06)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.borderColor = C.borderHi;
                        e.currentTarget.style.background = "transparent";
                      }}
                    >
                      ▸ {w.adapter.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </aside>
  );
}

function WalletItem({ color, chain }: { color: string; chain: string }) {
  const itemStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 9,
    padding: "7px 18px",
    fontSize: 14,
    color: C.text,
    textDecoration: "none",
    letterSpacing: "0.02em",
    fontFamily: FONT,
    borderLeft: "2px solid transparent",
    cursor: "default",
  };
  return (
    <div style={itemStyle}>
      <span style={{ fontSize: 12, width: 14, textAlign: "center", color, opacity: 1, flexShrink: 0 }}>
        ◆
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {chain}
      </span>
    </div>
  );
}
