import TerminalNavbar from "../components/TerminalNavbar";
import type { CSSProperties } from "react";

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
  textWhite: "var(--fg)",
  green:     "var(--accent)",
  greenDim:  "var(--accent-hover)",
  greenFaint:"color-mix(in srgb, var(--accent) 6%, transparent)",
  greenGlow: "color-mix(in srgb, var(--accent) 18%, transparent)",
  cyan:      "var(--info)",
  amber:     "var(--warn)",
} as const;

const FONT = "'JetBrains Mono','Courier New',monospace";

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
      fontSize: 22, fontWeight: 700, color: C.textWhite, letterSpacing: "-0.01em",
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

function SectionEyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 11, color: "var(--line-strong)", letterSpacing: "0.18em",
      textTransform: "uppercase", marginBottom: 14,
    }}>
      {"// "}<span style={{ color: C.green }}>{children}</span>
    </div>
  );
}

const CHAINS: string[] = [
  "Base", "Ethereum", "Arbitrum", "Optimism", "Polygon",
  "Solana", "Sui", "HyperEVM", "BNB Chain",
];

const PROTOCOLS: string[] = [
  "Aerodrome", "Uniswap V3", "Velodrome", "Orca", "Raydium",
  "Bluefin", "PancakeSwap", "HyperSwap", "ProjectX", "KittenSwap",
  "Cetus", "Momentum", "AAVE V3", "Jupiter Lend", "AlphaFi",
  "Suilend", "HyperLend",
];

type Entry = { name: string; desc: string };

const DASHBOARD_ENTRIES: Entry[] = [
  { name: "Total Portfolio Value", desc: "Live mark-to-market value of all LP and lending positions combined." },
  { name: "Positions / Avg APY / Uncollected Fees / Daily Yield", desc: "Summary stats across all your active positions." },
  { name: "Wallets", desc: "All connected or watched wallets. Add multiple wallets to see an aggregated view." },
  { name: "Estimated Net Cashflow", desc: "Projected daily, weekly, monthly, and yearly income based on your current positions and APR." },
  { name: "Lend & Borrow", desc: "All lending positions across AAVE V3, Jupiter Lend, AlphaFi, Suilend, and HyperLend showing supplied amount and APY." },
  { name: "Protocol Allocation", desc: "Donut chart showing portfolio value breakdown by protocol." },
  { name: "Chain Distribution", desc: "Portfolio value breakdown by chain with percentages." },
  { name: "Yield History", desc: "Portfolio value over time — switch between 1D, 7D, 30D, 90D, 1Y timeframes." },
  { name: "Cash Flow", desc: "Daily, weekly, monthly income summary and total uncollected fees across all positions." },
  { name: "Positions Table", desc: "All LP positions showing value, APR, P&L, and health score. Filter by In Range, Out of Range, Closed, or All Positions. Filter by chain: EVM, Solana, Sui." },
];

const POSITION_ENTRIES: Entry[] = [
  { name: "Position Header", desc: "Pair name, protocol, chain, wallet address, open date, and active status." },
  { name: "Total Value + Uncollected Fees", desc: "Live position value mark-to-market and pending fees ready to claim on-chain." },
  { name: "Current Liquidity", desc: "Exact token amounts currently deposited in the pool with USD value and percentage split." },
  { name: "Uncollected Fees", desc: "Exact fee amounts per token accumulated and ready to claim, with total USD value." },
  { name: "Performance Metrics", desc: "Shows Actual APR calculated from real on-chain fee claims — not estimates. Use the D/W/M/Y toggle to switch between daily, weekly, monthly, and yearly rate. Also shows Estimated APR from pool rate, position age, and actual daily income." },
  { name: "Fee Accumulation Chart", desc: "Cumulative fees collected over the entire position lifetime with avg/claim and peak claim stats." },
  { name: "Fee Claims History", desc: "Every on-chain fee claim transaction with exact date, time, and USD amount." },
  { name: "Concentrated Liquidity Range", desc: "Visual price range bar showing min price, current price, and max price. Green bar shows where current price sits within your range. Shows range width, distance to lower bound, distance to upper bound, and position age." },
  { name: "Yield & APR Projections", desc: "Forward-looking daily, weekly, monthly, yearly estimates based on current pool fee rate." },
  { name: "On-Chain P&L", desc: "Initial deposit value vs current value, total fees collected, impermanent loss, and net P&L with full formula shown." },
  { name: "Pool Statistics", desc: "Pool TVL, 24h volume, and fee rate." },
];

const ANALYTICS_ENTRIES: Entry[] = [
  { name: "Health Score", desc: "Score out of 100 rating the overall health of your portfolio based on positions in range, fee activity, and diversification." },
  { name: "Overview Stats", desc: "Total portfolio value, daily income, unclaimed fees, and actual APR across all positions." },
  { name: "Fee Income", desc: "Cumulative fees collected across all LP positions. Shows last 30 days, hourly rate, annualized projection, and lifetime total. Chart shows fee accumulation over time with protocol breakdown." },
  { name: "LP Profit & Loss", desc: "Aggregated P&L across all positions — total deposited at entry prices, current mark-to-market value, lifetime fees collected at claim-time prices, unclaimed fees, impermanent loss, and net P&L." },
  { name: "Income by Source", desc: "Donut chart splitting daily/monthly/yearly income between LP fees and lending interest." },
  { name: "Income by Chain", desc: "Fee income broken down by chain showing proportional bars and monthly projection per chain." },
  { name: "Position Performance", desc: "Full table of all positions with APR, fees collected, daily income, and in/out of range status." },
  { name: "Earning Flows", desc: "Live feed of recent on-chain fee claim events showing protocol, chain, and USD amount." },
  { name: "Chain Exposure", desc: "Donut chart showing total portfolio value allocation by chain." },
  { name: "Protocol Exposure", desc: "Donut chart showing total portfolio value allocation by protocol." },
  { name: "Performance Rankings", desc: "Top performers and lowest yield positions ranked by actual APR from claimed fees." },
];

const CONCEPTS: Entry[] = [
  {
    name: "Actual APR vs Estimated APR",
    desc: "Actual APR is calculated from your real on-chain fee claims — what you actually earned divided by your position value over time. Estimated APR is based on the pool's current fee rate — what you might earn going forward. Always trust Actual APR over Estimated APR when evaluating a position's real performance.",
  },
  {
    name: "Impermanent Loss",
    desc: "IL measures how much less your deposit is worth compared to simply holding the tokens outside the pool. It occurs when the price ratio between your two tokens changes after deposit. A positive IL number means the pool movement has cost you relative to holding. Fees earned over time can offset IL.",
  },
  {
    name: "Net P&L",
    desc: "Net P&L = Current Value + Fees Collected + Fees Unclaimed - Initial Deposit. A positive number means you are ahead of your initial investment including all fees earned. A negative number means fees have not yet covered your IL and price exposure.",
  },
  {
    name: "In Range vs Out of Range",
    desc: "Concentrated liquidity positions only earn fees when the current market price is within your set price range. Out of Range means you are earning zero fees right now. Rebalancing or adjusting your range can bring you back in range.",
  },
  {
    name: "Watch Wallet",
    desc: "Paste any wallet address to view it in read-only mode without connecting. DefiDesh never asks for private keys, seed phrases, or transaction signing. It only reads publicly available on-chain data.",
  },
  {
    name: "Real Data Only",
    desc: "DefiDesh calculates fees from actual on-chain claim events, APR from your real fee history, and P&L from your actual deposit transactions. We never show estimates where real data is available.",
  },
];

const PRIVACY: string[] = [
  "DefiDesh is 100% read-only. We never ask for private keys, seed phrases, or transaction signing.",
  "All data is fetched live from public blockchain RPCs and on-chain events. Nothing is stored on our servers.",
  "No personal data is collected. Wallet addresses you enter are only used to fetch on-chain data for that session.",
  "DefiDesh is non-custodial. We have zero access to your funds at any time.",
];

type Toc = { id: string; label: string };
const TOC: Toc[] = [
  { id: "getting-started", label: "Getting Started" },
  { id: "dashboard",       label: "Dashboard" },
  { id: "position-detail", label: "Position Detail" },
  { id: "analytics",       label: "Analytics" },
  { id: "key-concepts",    label: "Key Concepts" },
  { id: "data-privacy",    label: "Data & Privacy" },
];

function EntryRow({ entry }: { entry: Entry }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 4,
      padding: "12px 0",
      borderBottom: `1px dashed ${C.border}`,
    }}>
      <div style={{
        fontSize: 14, color: C.textBright, fontWeight: 600, letterSpacing: "0.01em",
      }}>
        {entry.name}
      </div>
      <div style={{ fontSize: 14, color: C.textMid, lineHeight: 1.65 }}>
        {entry.desc}
      </div>
    </div>
  );
}

export default function Docs() {
  return (
    <div style={{
      background: C.bg, color: C.text, minHeight: "100vh",
      fontFamily: FONT, fontSize: 16, lineHeight: 1.55, overflowX: "hidden",
      paddingTop: 52,
      scrollBehavior: "smooth",
    }}>
      <style>{`
        @keyframes _fadeUp { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
        html { scroll-behavior: smooth; }
        .docs-toc-link { transition: all 0.15s; }
        .docs-toc-link:hover { color: ${C.green} !important; border-color: ${C.greenDim} !important; background: ${C.greenFaint} !important; }
        .docs-chip { transition: all 0.15s; }
        .docs-chip:hover { border-color: ${C.greenDim} !important; background: ${C.greenFaint} !important; color: ${C.green} !important; }
        .docs-step-num { transition: all 0.15s; }
        @media (max-width: 768px) {
          .docs-chains, .docs-protocols { grid-template-columns: repeat(2, 1fr) !important; }
          .docs-toc { grid-template-columns: repeat(2, 1fr) !important; }
        }
      `}</style>

      <TerminalNavbar />

      <div style={{
        maxWidth: 880, margin: "0 auto",
        padding: "56px 28px 96px",
        animation: "_fadeUp 0.5s ease both",
      }}>
        {/* Eyebrow + Title */}
        <div style={{
          fontSize: 12, color: C.green, letterSpacing: "0.22em",
          textTransform: "uppercase", marginBottom: 14, opacity: 0.85,
        }}>
          <span style={{ opacity: 0.6 }}>// </span>Docs · Knowledge Base
        </div>
        <h1 style={{
          fontSize: 38, fontWeight: 700, color: C.textWhite,
          letterSpacing: "-0.02em", lineHeight: 1.1, marginBottom: 12,
        }}>
          Documentation
        </h1>
        <p style={{ fontSize: 16, color: C.green, opacity: 0.85, maxWidth: 640 }}>
          Everything you need to understand and use DefiDesh
        </p>

        {/* ── TABLE OF CONTENTS ────────────────────────────────────────── */}
        <div style={{ ...cardStyle, animationDelay: "0.03s" }}>
          <div aria-hidden style={cardTopAccent} />
          <SectionEyebrow>Contents</SectionEyebrow>
          <div className="docs-toc" style={{
            display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10,
          }}>
            {TOC.map((t) => (
              <a
                key={t.id}
                href={`#${t.id}`}
                className="docs-toc-link"
                style={{
                  display: "block",
                  border: `1px solid ${C.borderHi}`,
                  background: C.bg2,
                  padding: "12px 14px",
                  textAlign: "left",
                  fontSize: 14,
                  color: C.textMid,
                  letterSpacing: "0.04em",
                  textDecoration: "none",
                }}
              >
                <span style={{ color: C.green, opacity: 0.7, marginRight: 6 }}>▸</span>
                {t.label}
              </a>
            ))}
          </div>
        </div>

        {/* ── GETTING STARTED ──────────────────────────────────────────── */}
        <div id="getting-started" style={{ ...cardStyle, animationDelay: "0.05s", scrollMarginTop: 80 }}>
          <div aria-hidden style={cardTopAccent} />
          <SectionEyebrow>Getting Started</SectionEyebrow>
          <H2>What is DefiDesh</H2>
          <p style={{ color: C.textMid, fontSize: 15, lineHeight: 1.75, marginBottom: 24 }}>
            DefiDesh is a deep DeFi portfolio tracker. Paste any wallet address or connect
            your wallet to see all your LP positions, lending positions, fees earned, APR,
            impermanent loss, and P&amp;L — all calculated from real on-chain data.
          </p>

          <div style={{
            fontSize: 13, color: C.textBright, letterSpacing: "0.1em",
            textTransform: "uppercase", marginBottom: 16, marginTop: 8,
          }}>
            How to connect
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 26 }}>
            {[
              "Paste your wallet address into the scanner on the homepage",
              "Or click Connect Wallet to connect via MetaMask or WalletConnect",
              "Your dashboard loads automatically with all your positions",
            ].map((step, i) => (
              <div key={i} style={{
                display: "flex", alignItems: "flex-start", gap: 14,
                fontSize: 15, color: C.textMid,
              }}>
                <span className="docs-step-num" style={{
                  width: 26, height: 26, display: "inline-flex",
                  alignItems: "center", justifyContent: "center", flexShrink: 0,
                  fontSize: 12, fontWeight: 700,
                  border: `1px solid ${C.greenDim}`,
                  background: C.greenFaint, color: C.green,
                  boxShadow: `0 0 8px ${C.greenGlow}`,
                  letterSpacing: "0",
                }}>
                  {i + 1}
                </span>
                <span style={{ lineHeight: 1.6, paddingTop: 3 }}>
                  <span style={{ color: C.text, opacity: 0.6, marginRight: 8 }}>
                    Step {i + 1} —
                  </span>
                  {step}
                </span>
              </div>
            ))}
          </div>

          <div style={{
            fontSize: 13, color: C.textBright, letterSpacing: "0.1em",
            textTransform: "uppercase", marginBottom: 12,
          }}>
            Supported chains
          </div>
          <div className="docs-chains" style={{
            display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 24,
          }}>
            {CHAINS.map((ch) => (
              <div key={ch} className="docs-chip" style={{
                border: `1px solid ${C.borderHi}`,
                background: C.bg2,
                padding: "10px 14px",
                fontSize: 14,
                color: C.textBright,
                letterSpacing: "0.04em",
                textAlign: "center",
              }}>
                {ch}
              </div>
            ))}
          </div>

          <div style={{
            fontSize: 13, color: C.textBright, letterSpacing: "0.1em",
            textTransform: "uppercase", marginBottom: 12,
          }}>
            Supported protocols
          </div>
          <div className="docs-protocols" style={{
            display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10,
          }}>
            {PROTOCOLS.map((p) => (
              <div key={p} className="docs-chip" style={{
                border: `1px solid ${C.borderHi}`,
                background: C.bg2,
                padding: "10px 14px",
                fontSize: 14,
                color: C.textMid,
                letterSpacing: "0.04em",
                textAlign: "center",
              }}>
                {p}
              </div>
            ))}
          </div>
        </div>

        {/* ── DASHBOARD ────────────────────────────────────────────────── */}
        <div id="dashboard" style={{ ...cardStyle, animationDelay: "0.1s", scrollMarginTop: 80 }}>
          <div aria-hidden style={cardTopAccent} />
          <SectionEyebrow>Dashboard</SectionEyebrow>
          <H2>Dashboard Page</H2>
          <div>
            {DASHBOARD_ENTRIES.map((e) => <EntryRow key={e.name} entry={e} />)}
          </div>
        </div>

        {/* ── POSITION DETAIL ──────────────────────────────────────────── */}
        <div id="position-detail" style={{ ...cardStyle, animationDelay: "0.15s", scrollMarginTop: 80 }}>
          <div aria-hidden style={cardTopAccent} />
          <SectionEyebrow>Position Detail</SectionEyebrow>
          <H2>Position Detail Page</H2>
          <div>
            {POSITION_ENTRIES.map((e) => <EntryRow key={e.name} entry={e} />)}
          </div>
        </div>

        {/* ── ANALYTICS ────────────────────────────────────────────────── */}
        <div id="analytics" style={{ ...cardStyle, animationDelay: "0.2s", scrollMarginTop: 80 }}>
          <div aria-hidden style={cardTopAccent} />
          <SectionEyebrow>Analytics</SectionEyebrow>
          <H2>Analytics Page</H2>
          <div>
            {ANALYTICS_ENTRIES.map((e) => <EntryRow key={e.name} entry={e} />)}
          </div>
        </div>

        {/* ── KEY CONCEPTS ─────────────────────────────────────────────── */}
        <div id="key-concepts" style={{ ...cardStyle, animationDelay: "0.25s", scrollMarginTop: 80 }}>
          <div aria-hidden style={cardTopAccent} />
          <SectionEyebrow>Key Concepts</SectionEyebrow>
          <H2>Key Concepts</H2>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {CONCEPTS.map((c) => (
              <div key={c.name} style={{
                border: `1px solid ${C.borderHi}`,
                background: "var(--surface)",
                padding: "18px 20px",
                borderRadius: 4,
                position: "relative",
              }}>
                <div style={{
                  fontSize: 14, color: C.green, letterSpacing: "0.08em",
                  textTransform: "uppercase", marginBottom: 8,
                  display: "flex", alignItems: "center", gap: 8,
                }}>
                  <span style={{
                    width: 5, height: 5, background: C.green, flexShrink: 0,
                    boxShadow: `0 0 6px ${C.greenGlow}`,
                  }} />
                  {c.name}
                </div>
                <div style={{ fontSize: 14, color: C.textMid, lineHeight: 1.7 }}>
                  {c.desc}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── DATA & PRIVACY ───────────────────────────────────────────── */}
        <div id="data-privacy" style={{ ...cardStyle, animationDelay: "0.3s", scrollMarginTop: 80 }}>
          <div aria-hidden style={cardTopAccent} />
          <SectionEyebrow>Data &amp; Privacy</SectionEyebrow>
          <H2>Data &amp; Privacy</H2>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {PRIVACY.map((line) => (
              <div key={line} style={{
                display: "flex", alignItems: "flex-start", gap: 14,
                fontSize: 15, color: C.textMid,
              }}>
                <span style={{
                  width: 16, height: 16, display: "inline-flex",
                  alignItems: "center", justifyContent: "center", flexShrink: 0,
                  fontSize: 12, fontWeight: 700,
                  border: `1px solid ${C.greenDim}`,
                  background: C.greenFaint, color: C.green,
                  boxShadow: `0 0 8px ${C.greenGlow}`,
                  marginTop: 1,
                }}>
                  ✓
                </span>
                <span style={{ lineHeight: 1.6 }}>{line}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Footer line */}
        <div style={{
          textAlign: "center",
          padding: "32px 0 8px",
          fontSize: 12, color: C.text,
          letterSpacing: "0.14em", textTransform: "uppercase",
          opacity: 0.5,
        }}>
          Built by <span style={{ color: C.green }}>Osho</span> · 2026
        </div>
      </div>
    </div>
  );
}
