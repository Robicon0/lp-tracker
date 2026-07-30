"use client";

import { useState, useEffect, useRef, type CSSProperties } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { useWallet } from "@solana/wallet-adapter-react";
import type { WalletName } from "@solana/wallet-adapter-base";
import {
  useCurrentAccount,
  useWallets,
  useConnectWallet,
  useDisconnectWallet,
} from "@mysten/dapp-kit";
import { useRouter } from "next/navigation";
import { useWalletAuth } from "../contexts/WalletAuthContext";
import { setDisconnected } from "../lib/walletDisconnectFlag";
import { detectChain } from "../lib/detectChain";

const EVM_DISPLAY: { id: string; name: string }[] = [
  { id: "metaMaskSDK", name: "MetaMask" },
  { id: "rabby", name: "Rabby Wallet" },
  { id: "coinbaseWalletSDK", name: "Coinbase Wallet" },
  { id: "walletConnect", name: "WalletConnect" },
  { id: "phantom", name: "Phantom" },
];

// Curated allow-lists for the Solana and Sui wallet pickers — case-insensitive
// substring match. Wallet Standard surfaces cross-chain wallets (MetaMask Snap
// on Solana, Phantom on Sui, etc.) that we don't want polluting these pickers.
// Keep these lists in sync with the matching list in
// app/components/DashboardSidebar.tsx.
const SOLANA_ALLOWED_NAMES = ["phantom", "backpack", "solflare"];
const SUI_ALLOWED_NAMES = ["sui wallet", "slush", "backpack", "martian"];

function matchesAllowList(name: string, allowed: string[]): boolean {
  const lower = name.toLowerCase();
  return allowed.some((n) => lower.includes(n));
}

function truncate(addr: string) {
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

export default function HeroWalletConnect() {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // EVM — wagmi for connect/disconnect mechanics; display identity from
  // WalletAuthContext.evmAddress (persisted last-confirmed, parity with Sol/Sui).
  useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const [showEvmModal, setShowEvmModal] = useState(false);

  // Solana
  const {
    select,
    connect: connectSolana,
    disconnect: disconnectSolana,
    connected: adapterSolanaConnected,
    publicKey: adapterPublicKey,
    wallets: solanaWallets,
  } = useWallet();
  const [showSolanaModal, setShowSolanaModal] = useState(false);
  const awaitingSolanaConnect = useRef(false);

  // Sui
  const adapterSuiAccount = useCurrentAccount();
  const suiWallets = useWallets();
  const { mutateAsync: connectSuiAsync } = useConnectWallet();
  const { mutate: disconnectSui } = useDisconnectWallet();
  const [showSuiModal, setShowSuiModal] = useState(false);
  const awaitingSuiConnect = useRef(false);

  const { evmAddress, setEvmAddress, solanaAddress, setSolanaAddress, suiAddress, setSuiAddress } = useWalletAuth();
  const address = evmAddress;
  const isConnected = !!evmAddress;

  useEffect(() => {
    if (awaitingSolanaConnect.current && adapterSolanaConnected && adapterPublicKey) {
      setSolanaAddress(adapterPublicKey.toBase58());
      awaitingSolanaConnect.current = false;
    }
  }, [adapterSolanaConnected, adapterPublicKey, setSolanaAddress]);

  useEffect(() => {
    if (awaitingSuiConnect.current && adapterSuiAccount) {
      setSuiAddress(adapterSuiAccount.address);
      awaitingSuiConnect.current = false;
    }
  }, [adapterSuiAccount, setSuiAddress]);

  const handleEvmConnect = (id: string) => {
    const conn = connectors.find((c) => c.id === id);
    if (!conn) return;
    connect({ connector: conn });
    setShowEvmModal(false);
  };

  const handleEvmDisconnect = () => {
    setDisconnected("evm");
    setEvmAddress(null); // clears the persisted identity too
    disconnect();
  };

  const handleSolanaConnect = async (walletName: string) => {
    setShowSolanaModal(false);
    try {
      if (adapterSolanaConnected && adapterPublicKey) {
        setSolanaAddress(adapterPublicKey.toBase58());
        return;
      }
      select(walletName as WalletName);
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

  const handleSuiConnect = async (wallet: (typeof suiWallets)[number]) => {
    try {
      awaitingSuiConnect.current = true;
      await connectSuiAsync({ wallet });
    } catch (err) {
      awaitingSuiConnect.current = false;
      console.error("Sui connect error:", err);
    }
    setShowSuiModal(false);
  };

  const handleSuiDisconnect = () => {
    setDisconnected("sui");
    setSuiAddress(null);
    if (typeof window !== "undefined") localStorage.removeItem("defidesh-sui-addr");
    disconnectSui();
  };

  const [addrInput, setAddrInput] = useState("");
  const [scanError, setScanError] = useState<string | null>(null);
  function handleScan(e: React.FormEvent) {
    e.preventDefault();
    const v = addrInput.trim();
    if (!v) return;
    // Detect EVM (0x + 40 hex), Sui (0x + 64 hex), or Solana (base58 32-44).
    // Unknown formats show an inline error and don't navigate — the dashboard
    // can't load anything useful without a chain hint.
    const chain = detectChain(v);
    if (!chain) {
      setScanError("Unrecognized address. Use 0x… (EVM/Sui) or a Solana base58 address.");
      return;
    }
    setScanError(null);
    router.push(`/dashboard?address=${encodeURIComponent(v)}&chain=${chain}`);
  }

  const evmActive = mounted && isConnected && !!address;
  const solActive = mounted && !!solanaAddress;
  const suiActive = mounted && !!suiAddress;

  return (
    <div className="space-y-4">
      {/* CONNECT WALLET */}
      <div>
        <div className="text-[12px] text-[var(--fg-subtle)] tracking-[0.12em] uppercase mb-2.5">
          {"// connect wallet"}
        </div>
        <div
          className="hwc-chips"
          style={{
            display: "flex",
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "flex-start",
            gap: 8,
          }}
        >
          <ChainButton
            chainColor="var(--info)"
            label="EVM"
            sublabel="MetaMask / WC"
            connected={evmActive}
            connectedAddress={address ?? null}
            onConnect={() => mounted && setShowEvmModal(true)}
            onDisconnect={handleEvmDisconnect}
          />
          <ChainButton
            chainColor="var(--chain-solana)"
            label="SOLANA"
            sublabel="Phantom"
            connected={solActive}
            connectedAddress={solanaAddress}
            onConnect={() => mounted && setShowSolanaModal(true)}
            onDisconnect={handleSolanaDisconnect}
          />
          <ChainButton
            chainColor="var(--chain-sui)"
            label="SUI"
            sublabel="Slush / Suiet"
            connected={suiActive}
            connectedAddress={suiAddress}
            onConnect={() => mounted && setShowSuiModal(true)}
            onDisconnect={handleSuiDisconnect}
          />
        </div>
      </div>

      {/* OR PASTE ANY ADDRESS */}
      <div>
        <div className="text-[12px] text-[var(--fg-subtle)] tracking-[0.12em] uppercase mb-2.5">
          {"// or paste any address"}
        </div>
        <form
          onSubmit={handleScan}
          className="flex border border-[var(--line-strong)] max-w-[480px] focus-within:border-[var(--accent)]/60 transition-colors"
        >
          <span
            className="bg-[var(--surface)] text-[var(--accent)] px-3.5 py-2.5 text-[15px] border-r border-[var(--line-strong)] select-none flex-shrink-0"
            style={{ fontFamily: "var(--font-jetbrains-mono)" }}
          >
            {">_"}
          </span>
          <input
            type="text"
            value={addrInput}
            onChange={(e) => setAddrInput(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            placeholder="0x... or sol1... or 0x(sui)..."
            className="flex-1 bg-[var(--surface)] text-[var(--fg)] px-3.5 py-2.5 text-[15px] outline-none placeholder:text-[var(--fg-subtle)] min-w-0"
            style={{ fontFamily: "var(--font-jetbrains-mono)", letterSpacing: "0.04em" }}
          />
          <button
            type="submit"
            className="bg-[var(--surface)] text-[var(--fg-subtle)] hover:text-[var(--accent)] hover:bg-[color-mix(in srgb, var(--accent) 6%, transparent)] border-l border-[var(--line-strong)] px-4 py-2.5 text-[14px] tracking-[0.08em] uppercase transition-colors whitespace-nowrap"
          >
            SCAN
          </button>
        </form>
        {scanError && (
          <div
            style={{
              marginTop: 8,
              fontSize: 12,
              color: "var(--neg)",
              letterSpacing: "0.04em",
            }}
          >
            {scanError}
          </div>
        )}
      </div>

      {/* MODALS */}
      {showEvmModal && (
        <TerminalModal title="CONNECT_EVM_WALLET" onClose={() => setShowEvmModal(false)}>
          <div className="space-y-2">
            {EVM_DISPLAY.map((meta) => {
              if (!connectors.some((c) => c.id === meta.id)) return null;
              return (
                <button
                  key={meta.id}
                  onClick={() => handleEvmConnect(meta.id)}
                  className="w-full border border-[var(--line-strong)] hover:border-[var(--info)] hover:bg-[color-mix(in srgb, var(--info) 5%, transparent)] px-4 py-3 text-left text-base text-[var(--fg)] tracking-wider transition-colors"
                >
                  ▸ {meta.name}
                </button>
              );
            })}
          </div>
        </TerminalModal>
      )}

      {showSolanaModal && (() => {
        const filtered = solanaWallets.filter((w) =>
          matchesAllowList(w.adapter.name, SOLANA_ALLOWED_NAMES),
        );
        return (
          <TerminalModal title="CONNECT_SOLANA_WALLET" onClose={() => setShowSolanaModal(false)}>
            {filtered.length === 0 ? (
              <p className="text-sm text-[var(--fg-subtle)] leading-relaxed">
                No Solana wallet detected. Install Phantom, Backpack, or Solflare.
              </p>
            ) : (
              <div className="space-y-2">
                {filtered.map((w) => (
                  <button
                    key={w.adapter.name}
                    onClick={() => handleSolanaConnect(w.adapter.name)}
                    className="w-full border border-[var(--line-strong)] hover:border-[var(--chain-solana)] hover:bg-[rgba(153,69,255,0.05)] px-4 py-3 text-left text-base text-[var(--fg)] tracking-wider transition-colors"
                  >
                    ▸ {w.adapter.name}
                  </button>
                ))}
              </div>
            )}
          </TerminalModal>
        );
      })()}

      {showSuiModal && (() => {
        const filtered = suiWallets.filter((w) =>
          matchesAllowList(w.name, SUI_ALLOWED_NAMES),
        );
        return (
          <TerminalModal title="CONNECT_SUI_WALLET" onClose={() => setShowSuiModal(false)}>
            {filtered.length === 0 ? (
              <p className="text-sm text-[var(--fg-subtle)] leading-relaxed">
                No Sui wallet detected. Install Sui Wallet, Slush, Backpack, or Martian.
              </p>
            ) : (
              <div className="space-y-2">
                {filtered.map((w) => (
                  <button
                    key={w.name}
                    onClick={() => handleSuiConnect(w)}
                    className="w-full border border-[var(--line-strong)] hover:border-[var(--chain-sui)] hover:bg-[rgba(77,162,255,0.05)] px-4 py-3 text-left text-base text-[var(--fg)] tracking-wider transition-colors"
                  >
                    ▸ {w.name}
                  </button>
                ))}
              </div>
            )}
          </TerminalModal>
        );
      })()}
    </div>
  );
}

const GLOW: Record<string, string> = {
  "var(--info)": "0 0 12px color-mix(in srgb, var(--info) 18%, transparent)",
  "var(--chain-solana)": "0 0 12px rgba(153,69,255,0.18)",
  "var(--chain-sui)": "0 0 12px rgba(77,162,255,0.18)",
};

function ChainButton({
  chainColor,
  label,
  sublabel,
  connected,
  connectedAddress,
  onConnect,
  onDisconnect,
}: {
  chainColor: string;
  label: string;
  sublabel: string;
  connected: boolean;
  connectedAddress: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const [hover, setHover] = useState(false);

  const baseStyle: CSSProperties = {
    background: hover ? "#161616" : "var(--surface)",
    border: `1px solid ${connected ? "var(--accent)" : hover ? chainColor : "var(--line-strong)"}`,
    boxShadow: hover && !connected ? GLOW[chainColor] : connected ? "0 0 12px color-mix(in srgb, var(--accent) 15%, transparent)" : "none",
    color: "var(--fg-muted)",
    padding: "10px 14px",
    fontSize: 14,
    fontWeight: 700,
    letterSpacing: "0.1em",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    whiteSpace: "nowrap",
    transition: "all 0.15s",
    fontFamily: "var(--font-jetbrains-mono)",
    width: "fit-content",
    flex: "0 0 auto",
  };

  if (connected && connectedAddress) {
    return (
      <button
        type="button"
        title="Click to disconnect"
        onClick={onDisconnect}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={baseStyle}
      >
        <span style={{ color: "var(--accent)", fontSize: 14 }}>✓</span>
        <span>{label}</span>
        <span
          style={{
            fontSize: 11,
            color: "var(--fg-subtle)",
            fontWeight: 400,
            letterSpacing: "0.04em",
          }}
        >
          {truncate(connectedAddress)}
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onConnect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={baseStyle}
    >
      <span
        style={{ width: 6, height: 6, background: chainColor, flexShrink: 0 }}
        aria-hidden
      />
      <span>{label}</span>
      <span style={{ fontSize: 11, color: "var(--fg-subtle)", fontWeight: 400, letterSpacing: "0.06em" }}>
        {sublabel}
      </span>
    </button>
  );
}

function TerminalModal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center px-4"
      style={{ fontFamily: "var(--font-jetbrains-mono)" }}
    >
      <div className="absolute inset-0 backdrop-blur-sm" style={{ background: "var(--overlay)" }} onClick={onClose} />
      <div className="relative border border-[var(--accent)] w-full max-w-sm" style={{ background: "var(--surface)" }}>
        <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--accent)]">
          <span className="text-[var(--accent)] text-[14px] tracking-widest font-bold">{title}</span>
          <button
            onClick={onClose}
            className="text-[var(--accent)]/80 hover:text-[var(--accent)] text-sm tracking-widest"
          >
            [X]
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
