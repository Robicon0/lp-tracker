import Link from "next/link";
import HeroWalletConnect from "./components/HeroWalletConnect";
import DashboardPreview from "./components/DashboardPreview";
import PriceTickerStrip from "./components/PriceTickerStrip";
import BlinkingCursor from "./components/BlinkingCursor";
import FeedbackTab from "./components/FeedbackTab";

const PROTOCOL_DEFS: {
  name: string;
  type: "LP" | "Lending";
  chain: string;
  // candidate slugs for /tvl/{slug} (TVL is summed across matches)
  slugs: string[];
  // candidate slugs for /summary/dexs/{slug} (24h volume) — empty for non-DEX
  dexSlugs: string[];
}[] = [
  {
    name: "Aerodrome",
    type: "LP",
    chain: "Base",
    slugs: ["aerodrome-slipstream", "aerodrome-v1"],
    dexSlugs: ["aerodrome-slipstream", "aerodrome-v1"],
  },
  {
    name: "Uniswap V3",
    type: "LP",
    chain: "EVM",
    slugs: ["uniswap-v3"],
    dexSlugs: ["uniswap-v3"],
  },
  {
    name: "Orca",
    type: "LP",
    chain: "Solana",
    slugs: ["orca"],
    dexSlugs: ["orca"],
  },
  {
    name: "Cetus",
    type: "LP",
    chain: "Sui",
    slugs: ["cetus-amm"],
    dexSlugs: ["cetus-amm"],
  },
  {
    name: "Bluefin",
    type: "LP",
    chain: "Sui",
    slugs: ["bluefin-spot"],
    dexSlugs: ["bluefin-spot"],
  },
  {
    name: "AAVE V3",
    type: "Lending",
    chain: "EVM",
    slugs: ["aave-v3"],
    dexSlugs: [],
  },
  {
    name: "Kamino",
    type: "Lending",
    chain: "Solana",
    slugs: ["kamino-lend"],
    dexSlugs: [],
  },
];

const FEATURES = [
  {
    num: "01",
    title: "Cross-Chain Aggregation",
    desc: "Unified view across Ethereum, Base, Arbitrum, Solana, and Sui. One wallet connection, all positions visible.",
  },
  {
    num: "02",
    title: "Real-Time P&L Tracking",
    desc: "Live unrealized gains, accrued fees, and impermanent loss calculations updated every block.",
  },
  {
    num: "03",
    title: "APY Intelligence",
    desc: "Composite APY across base rates, incentives, and fee income. Historical trend and anomaly detection baked in.",
  },
];

type Stat = { tvl: number | null; volume24h: number | null };

async function fetchTvl(slug: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.llama.fi/tvl/${slug}`, { next: { revalidate: 600 } });
    if (!res.ok) return null;
    const v = await res.json();
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

async function fetchDexVolume24h(slug: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://api.llama.fi/summary/dexs/${slug}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`,
      { next: { revalidate: 600 } },
    );
    if (!res.ok) return null;
    const json = await res.json();
    const v = json?.total24h;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

async function fetchProtocolStats(): Promise<Map<string, Stat>> {
  const out = new Map<string, Stat>();
  for (const p of PROTOCOL_DEFS) out.set(p.name, { tvl: null, volume24h: null });

  const tasks: Promise<void>[] = [];
  for (const p of PROTOCOL_DEFS) {
    tasks.push(
      Promise.all(p.slugs.map(fetchTvl)).then((vals) => {
        let total = 0;
        let found = false;
        for (const v of vals) {
          if (v != null) {
            total += v;
            found = true;
          }
        }
        if (found) out.get(p.name)!.tvl = total;
      }),
    );
    if (p.dexSlugs.length > 0) {
      tasks.push(
        Promise.all(p.dexSlugs.map(fetchDexVolume24h)).then((vals) => {
          let total = 0;
          let found = false;
          for (const v of vals) {
            if (v != null) {
              total += v;
              found = true;
            }
          }
          if (found) out.get(p.name)!.volume24h = total;
        }),
      );
    }
  }
  await Promise.all(tasks);
  return out;
}

function fmtBig(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

const SCANLINE_BG =
  "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.03) 2px, rgba(0,0,0,0.03) 4px)";

export default async function Home() {
  const stats = await fetchProtocolStats();

  return (
    <div
      className="min-h-screen bg-black"
      style={{
        fontFamily: "var(--font-jetbrains-mono), 'Courier New', monospace",
        color: "#c8c8c8",
        fontSize: 13,
        lineHeight: 1.6,
      }}
    >
      {/* Hide the global FloatingFeedback launcher only on this page — */}
      {/* the rotated FeedbackTab below triggers it programmatically. */}
      <style
        dangerouslySetInnerHTML={{
          __html: 'button[aria-label="Share feedback"] { display: none !important; }',
        }}
      />

      {/* Scanline overlay */}
      <div
        aria-hidden
        className="fixed inset-0 pointer-events-none z-[9999]"
        style={{ background: SCANLINE_BG }}
      />

      {/* NAV */}
      <nav
        className="sticky top-0 z-[10000] flex items-center justify-between h-[52px] px-4 sm:px-12 border-b border-[#1f1f1f]"
        style={{ background: "#000", backdropFilter: "blur(4px)" }}
      >
        <Link href="/" className="text-sm font-bold tracking-[0.12em] uppercase">
          <span className="text-[#00ff41]">DEFI</span>
          <span className="text-[#555]">/</span>
          <span className="text-[#555]">DESH</span>
        </Link>
        <div className="hidden md:flex gap-8">
          <Link
            href="/"
            className="text-[11px] text-[#c8c8c8] uppercase tracking-[0.08em] transition-colors"
          >
            Home
          </Link>
          <Link
            href="/dashboard"
            className="text-[11px] text-[#555] hover:text-[#c8c8c8] uppercase tracking-[0.08em] transition-colors"
          >
            Dashboard
          </Link>
          <Link
            href="/analytics"
            className="text-[11px] text-[#555] hover:text-[#c8c8c8] uppercase tracking-[0.08em] transition-colors"
          >
            Analytics
          </Link>
          <Link
            href="/about"
            className="text-[11px] text-[#555] hover:text-[#c8c8c8] uppercase tracking-[0.08em] transition-colors"
          >
            About
          </Link>
        </div>
        <div className="flex items-center gap-2 px-3 py-[5px] border border-[#00cc33] bg-[rgba(0,255,65,0.12)]">
          <span className="inline-block w-1.5 h-1.5 bg-[#00ff41] animate-pulse" />
          <span className="text-[10px] text-[#00ff41] uppercase tracking-[0.1em] hidden sm:inline">
            All systems nominal
          </span>
          <span className="text-[10px] text-[#00ff41] uppercase tracking-[0.1em] sm:hidden">LIVE</span>
        </div>
      </nav>

      {/* HERO */}
      <section className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] px-4 sm:px-12 border-b border-[#1f1f1f]">
        {/* LEFT */}
        <div className="lg:border-r border-[#1f1f1f] lg:pr-16 pt-12 lg:pt-16 pb-8 lg:pb-10 flex flex-col min-w-0">
          <div
            className="flex items-center gap-3 mb-7 text-[#555] tracking-[0.2em] uppercase"
            style={{ whiteSpace: "nowrap", fontSize: 13 }}
          >
            <span className="text-[#00ff41]">//</span>
            <span>DeFi Position Intelligence</span>
          </div>
          <h1
            className="font-bold text-[#e8e8e8] mb-6"
            style={{
              fontSize: "clamp(40px, 5vw, 72px)",
              lineHeight: 1.15,
              letterSpacing: "-0.02em",
            }}
          >
            Track every
            <br />
            <span className="text-[#00ff41]">DeFi position,</span>
            <br />
            one screen.
            <BlinkingCursor />
          </h1>
          <p
            className="text-[#555] max-w-[420px] mb-12 font-light"
            style={{ fontSize: 15, lineHeight: 1.9 }}
          >
            Real-time liquidity position tracking across EVM, Solana, and Sui. Value, APY, fees,
            and rewards — all in one place. Connect a wallet or paste any address.
          </p>
          <div className="flex gap-3 mb-10 flex-wrap">
            <Link
              href="/dashboard"
              className="bg-[#00ff41] hover:bg-[#00cc33] text-black font-bold tracking-[0.1em] uppercase transition-all hover:shadow-[0_0_24px_rgba(0,255,65,0.18)]"
              style={{ padding: "14px 32px", fontSize: 13 }}
            >
              ▸ Go to Dashboard
            </Link>
            <Link
              href="/analytics"
              className="border border-[#00e5ff] text-[#00e5ff] hover:bg-[rgba(0,229,255,0.1)] font-bold tracking-[0.1em] uppercase transition-all hover:shadow-[0_0_24px_rgba(0,229,255,0.15)]"
              style={{ padding: "14px 32px", fontSize: 13 }}
            >
              ▸ View Analytics
            </Link>
          </div>
          <HeroWalletConnect />
        </div>

        {/* RIGHT */}
        <div
          className="lg:pl-16 pt-8 lg:pt-16 pb-8 lg:pb-10 flex flex-col"
          style={{ alignSelf: "stretch" }}
        >
          <DashboardPreview />
        </div>
      </section>

      {/* STAT STRIP + TICKER */}
      <PriceTickerStrip />

      {/* PROTOCOLS */}
      <section className="px-4 sm:px-12 py-12 border-b border-[#1f1f1f]">
        <div className="text-[10px] text-[#555] uppercase tracking-[0.2em] mb-8 flex items-center gap-3">
          <span className="text-[#00ff41]">//</span>
          <span>Supported Protocols</span>
          <span className="flex-1 h-px bg-[#1f1f1f]" />
          <span className="text-[#444] tracking-[0.1em] text-[9px]">src: defillama</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-px bg-[#1f1f1f] border border-[#1f1f1f]">
          {PROTOCOL_DEFS.map((p) => {
            const s = stats.get(p.name) ?? { tvl: null, volume24h: null };
            const isDex = p.dexSlugs.length > 0;
            return (
              <div
                key={p.name}
                className="bg-black p-5 hover:bg-[#040404] transition-colors flex flex-col gap-2.5"
              >
                <div className="text-[9px] text-[#00ff41] tracking-[0.1em]">[{p.type.toUpperCase()}]</div>
                <div>
                  <div className="text-[13px] font-semibold text-[#e8e8e8]">{p.name}</div>
                  <div className="text-[9px] text-[#555] uppercase tracking-[0.1em] mt-0.5">
                    {p.chain}
                  </div>
                </div>
                <div className="flex flex-col gap-1.5 mt-1">
                  <div className="flex justify-between items-baseline text-[10px]">
                    <span className="text-[#555] tracking-[0.06em]">TVL</span>
                    <span className="text-[#00ff41] font-semibold tabular-nums">
                      {fmtBig(s.tvl)}
                    </span>
                  </div>
                  <div className="flex justify-between items-baseline text-[10px]">
                    <span className="text-[#555] tracking-[0.06em]">VOL 24H</span>
                    <span
                      className={`font-semibold tabular-nums ${isDex ? "text-[#00ff41]" : "text-[#444]"}`}
                    >
                      {isDex ? fmtBig(s.volume24h) : "n/a"}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* FEATURES */}
      <section className="grid grid-cols-1 md:grid-cols-3 border-b border-[#1f1f1f]">
        {FEATURES.map((f, i) => (
          <div
            key={f.num}
            className={`px-8 sm:px-12 py-10 ${i < FEATURES.length - 1 ? "md:border-r border-[#1f1f1f] border-b md:border-b-0" : ""}`}
          >
            <div
              className="font-bold text-[#2e2e2e] leading-none mb-4"
              style={{ fontSize: 48, letterSpacing: "-0.04em" }}
            >
              {f.num}
            </div>
            <div className="text-[13px] font-semibold text-[#e8e8e8] tracking-[0.04em] mb-2.5">
              {f.title}
            </div>
            <div className="text-[11px] text-[#555]" style={{ lineHeight: 1.8 }}>
              {f.desc}
            </div>
          </div>
        ))}
      </section>

      {/* FOOTER */}
      <footer className="px-4 sm:px-12 py-5 flex flex-col md:flex-row items-start md:items-center md:justify-between gap-3 text-[10px] text-[#555] tracking-[0.08em]">
        <div>
          <span className="text-[#c8c8c8]">DEFIDESH</span> — DeFi Position Intelligence{" "}
          <span className="text-[#00ff41]">//</span> v0.9.1-beta
        </div>
        <div className="flex gap-6">
          <a
            href="https://github.com/Robicon0/lp-tracker"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-[#c8c8c8] transition-colors"
          >
            GitHub
          </a>
          <Link href="/about" className="hover:text-[#c8c8c8] transition-colors">
            Docs
          </Link>
          <a href="#" className="hover:text-[#c8c8c8] transition-colors">
            Twitter
          </a>
          <a href="#" className="hover:text-[#c8c8c8] transition-colors">
            Discord
          </a>
        </div>
        <div>© 2026 DefiDesh. Not financial advice.</div>
      </footer>

      <FeedbackTab />
    </div>
  );
}
