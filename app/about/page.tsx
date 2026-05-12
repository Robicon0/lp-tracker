import TerminalNavbar from "../components/TerminalNavbar";
import type { CSSProperties } from "react";

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
  textWhite: "#f5f5f5",
  green:     "#00ff41",
  greenDim:  "#00b82a",
  greenFaint:"rgba(0,255,65,0.06)",
  greenGlow: "rgba(0,255,65,0.18)",
  cyan:      "#00d4ff",
  amber:     "#ffaa00",
} as const;

const FONT = "'JetBrains Mono','Courier New',monospace";

const SCANLINE_BG =
  "repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(0,0,0,0.015) 3px, rgba(0,0,0,0.015) 4px)";

const CHAINS: { name: string; color: string; live: boolean }[] = [
  { name: "Ethereum",  color: "#627eea", live: true  },
  { name: "Base",      color: "#0052ff", live: true  },
  { name: "Arbitrum",  color: "#28a0f0", live: true  },
  { name: "Optimism",  color: "#ff0420", live: true  },
  { name: "Polygon",   color: "#8247e5", live: true  },
  { name: "Solana",    color: "#9945ff", live: true  },
  { name: "Sui",       color: "#3d9fff", live: true  },
  { name: "HyperEVM",  color: "#00d4aa", live: true  },
  { name: "BNB Chain", color: "#f0b90b", live: true  },
  { name: "Avalanche", color: "#e84142", live: false },
];

// All features below are live. SOON tags removed per spec — real-time
// blockchain data, performance/IL charts, multi-wallet support, lending
// tracking, the analytics dashboard, and on-chain P&L are all shipped.
const FEATURES: string[] = [
  "Portfolio overview with total value and fees earned",
  "Filter positions by chain, protocol, and status",
  "Sort by value, APY, or fees",
  "Individual position detail pages",
  "Real-time on-chain data — Aerodrome, Uniswap V3, Velodrome, Orca, Raydium, Cetus, Bluefin, HyperSwap, KittenSwap, PRJX, PancakeSwap",
  "Performance charts and impermanent-loss tracking",
  "Multi-wallet support — EVM, Solana, Sui (connect + watched addresses)",
  "Lending & borrowing tracking — AAVE V3, Suilend, Kamino, Jupiter Lend, AlphaFi, HyperLend, HypurrFi, Dolomite",
  "Analytics dashboard — fee income, exposure donuts, performance rankings",
  "On-chain P&L with HODL comparison and IL identity",
  "MetaMask · Rabby · Coinbase · WalletConnect · Phantom support",
];

const TECH: string[] = [
  "Next.js 16",
  "React",
  "TypeScript",
  "Tailwind CSS",
  "wagmi v3",
  "viem",
  "Recharts",
  "@mysten/dapp-kit",
];

const cardStyle: CSSProperties = {
  border: `1px solid ${C.border}`,
  background: `linear-gradient(180deg, ${C.bg1}, ${C.bg})`,
  padding: "28px 30px",
  marginTop: 28,
  position: "relative",
  overflow: "hidden",
  animation: "_fadeUp 0.5s ease both",
};

const cardTopAccent: CSSProperties = {
  content: '""',
  position: "absolute",
  top: 0, left: 0, right: 0, height: 1,
  background: `linear-gradient(90deg, transparent, ${C.borderGlow}, transparent)`,
};

function H2({ children }: { children: React.ReactNode }) {
  return (
    <h2 style={{
      fontSize: 18, fontWeight: 700, color: C.textWhite, letterSpacing: "-0.01em",
      marginBottom: 16, display: "flex", alignItems: "center", gap: 10, fontFamily: FONT,
    }}>
      <span style={{
        width: 6, height: 6, background: C.green,
        boxShadow: `0 0 8px ${C.greenGlow}`,
      }} />
      {children}
    </h2>
  );
}

export default function About() {
  return (
    <div style={{
      background: C.bg, color: C.text, minHeight: "100vh",
      fontFamily: FONT, fontSize: 13, lineHeight: 1.55, overflowX: "hidden",
    }}>
      <style>{`
        @keyframes _fadeUp { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
        @keyframes _pulse  { 0%,100%{opacity:1} 50%{opacity:0.25} }
        .ab-chip { transition: all 0.15s; }
        .ab-chip:hover { border-color: ${C.greenDim} !important; background: ${C.greenFaint} !important; color: ${C.green} !important; }
        .ab-tech { transition: all 0.15s; }
        .ab-tech:hover { color: ${C.cyan} !important; border-color: rgba(0,212,255,0.45) !important; background: rgba(0,212,255,0.05) !important; }
      `}</style>

      {/* Scanline overlay */}
      <div aria-hidden style={{
        position: "fixed", inset: 0, pointerEvents: "none", zIndex: 9998, background: SCANLINE_BG,
      }} />

      <TerminalNavbar />

      <div style={{
        maxWidth: 880, margin: "0 auto",
        padding: "56px 28px 96px",
        animation: "_fadeUp 0.5s ease both",
      }}>
        {/* Eyebrow + Title */}
        <div style={{
          fontSize: 10, color: C.green, letterSpacing: "0.22em",
          textTransform: "uppercase", marginBottom: 14, opacity: 0.85,
        }}>
          <span style={{ opacity: 0.6 }}>// </span>About
        </div>
        <h1 style={{
          fontSize: 38, fontWeight: 700, color: C.textWhite,
          letterSpacing: "-0.02em", lineHeight: 1.1, marginBottom: 12,
        }}>
          About DefiDesh
        </h1>
        <p style={{ fontSize: 13, color: C.green, opacity: 0.85, maxWidth: 640 }}>
          A DeFi portfolio tracker for monitoring liquidity positions across multiple blockchains.
        </p>

        {/* ── WHAT IT DOES ─────────────────────────────────────────────── */}
        <div style={{ ...cardStyle, animationDelay: "0.05s" }}>
          <div aria-hidden style={cardTopAccent} />
          <H2>What It Does</H2>
          <p style={{ color: C.textMid, fontSize: 12.5, lineHeight: 1.75 }}>
            <strong style={{ color: C.textBright, fontWeight: 600 }}>DefiDesh</strong>
            {" "}helps liquidity providers monitor their positions across decentralized exchanges
            like{" "}
            <strong style={{ color: C.textBright, fontWeight: 600 }}>
              Uniswap, Aerodrome, Velodrome, Orca, Raydium, Cetus, Bluefin
            </strong>
            , and{" "}
            <strong style={{ color: C.textBright, fontWeight: 600 }}>HyperSwap</strong>.
            Track your portfolio value, APY, fees earned, impermanent loss, and lending
            positions — all in one place, with on-chain data refreshed every block.
          </p>
        </div>

        {/* ── SUPPORTED CHAINS ─────────────────────────────────────────── */}
        <div style={{ ...cardStyle, animationDelay: "0.1s" }}>
          <div aria-hidden style={cardTopAccent} />
          <H2>Supported Chains</H2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
            {CHAINS.map((ch) => (
              <div
                key={ch.name}
                className="ab-chip"
                style={{
                  border: `1px solid ${C.borderHi}`,
                  background: C.bg2,
                  padding: "14px 16px",
                  fontSize: 12,
                  color: ch.live ? C.textBright : C.text,
                  letterSpacing: "0.04em",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                  position: "relative",
                  opacity: ch.live ? 1 : 0.65,
                }}
              >
                <span style={{
                  width: 6, height: 6, background: ch.color, flexShrink: 0,
                  boxShadow: `0 0 6px ${ch.color}88`,
                }} />
                <span>{ch.name}</span>
                {!ch.live && (
                  <span style={{
                    marginLeft: 4,
                    fontSize: 9, padding: "1px 7px",
                    border: `1px solid ${C.amber}66`,
                    color: C.amber,
                    background: "rgba(255,170,0,0.05)",
                    letterSpacing: "0.1em",
                  }}>
                    SOON
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* ── FEATURES ─────────────────────────────────────────────────── */}
        <div style={{ ...cardStyle, animationDelay: "0.15s" }}>
          <div aria-hidden style={cardTopAccent} />
          <H2>Features</H2>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {FEATURES.map((f) => (
              <div key={f} style={{
                display: "flex", alignItems: "flex-start", gap: 14,
                fontSize: 12.5, color: C.textMid,
              }}>
                <span style={{
                  width: 16, height: 16, display: "inline-flex",
                  alignItems: "center", justifyContent: "center", flexShrink: 0,
                  fontSize: 10, fontWeight: 700,
                  border: `1px solid ${C.greenDim}`,
                  background: C.greenFaint, color: C.green,
                  boxShadow: `0 0 8px ${C.greenGlow}`,
                  marginTop: 1,
                }}>
                  ✓
                </span>
                <span style={{ lineHeight: 1.55 }}>{f}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── TECH STACK ───────────────────────────────────────────────── */}
        <div style={{ ...cardStyle, animationDelay: "0.2s" }}>
          <div aria-hidden style={cardTopAccent} />
          <H2>Tech Stack</H2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
            {TECH.map((t) => (
              <div
                key={t}
                className="ab-tech"
                style={{
                  border: `1px solid ${C.borderHi}`,
                  background: C.bg2,
                  padding: "12px 16px",
                  textAlign: "center",
                  fontSize: 12,
                  color: C.textMid,
                  letterSpacing: "0.04em",
                }}
              >
                {t}
              </div>
            ))}
          </div>
        </div>

        {/* Footer line */}
        <div style={{
          textAlign: "center",
          padding: "32px 0 8px",
          fontSize: 10, color: C.text,
          letterSpacing: "0.14em", textTransform: "uppercase",
          opacity: 0.5,
        }}>
          Built by <span style={{ color: C.green }}>Osho</span> · 2026
        </div>
      </div>
    </div>
  );
}
