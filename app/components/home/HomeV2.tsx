import Link from "next/link";
import { Fragment } from "react";
import CalculatorMenu from "../CalculatorMenu";
import HeroWalletConnect from "../HeroWalletConnect";
import DashboardPreview from "../DashboardPreview";
import PriceTickerStrip from "../PriceTickerStrip";
import ProtocolScroll, { type ProtocolScrollItem } from "../ProtocolScroll";
import MobileNavMenu from "../MobileNavMenu";
import ShipNotifications from "../ShipNotifications";
import ThemeToggle from "../theme/ThemeToggle";
import AmbientBackdrop from "./AmbientBackdrop";
import HeroV2 from "./HeroV2";
import TrustBand, { type TrustStat } from "./TrustBand";
import FeatureBento from "./FeatureBento";
import HowItWorks from "./HowItWorks";
import { Shell, SectionLabel } from "./Shell";

const NAV = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/analytics", label: "Analytics" },
  { href: "/docs", label: "Docs" },
  { href: "/about", label: "About" },
];

/**
 * DefiDesh home page.
 *
 * SECTION ORDER — "Real-Time / Operations Landing" pattern, which the design
 * system matches to live-status / ops products:
 *   1. Hero with a live product preview
 *   2. Key metrics
 *   3. Live market data + supported protocols
 *   4. How it works
 *   5. Capabilities
 *   6. CTA
 *
 * SYMMETRY — every section body renders inside <Shell>, so all of them share
 * one max-width and one gutter token. Every grid divides evenly (4 / 3 / 2)
 * and collapses to a factor of itself (4->2->1, 3->1, 2->1), so no breakpoint
 * ever leaves an orphan cell spanning a half-empty row.
 *
 * DENSITY — spacing comes from the 8px dashboard scale, not the 16px marketing
 * scale. Sections sit 40-64px apart instead of the previous 96-120px, which on
 * a 900px laptop viewport cost a full screen of emptiness between two pieces
 * of information.
 *
 * THEMING — zero hardcoded colours. Every value is a semantic token, so light
 * and dark are the same markup under a different data-theme attribute.
 */
export default function HomeV2({
  protocols,
  trustStats,
}: {
  protocols: ProtocolScrollItem[];
  trustStats: TrustStat[];
}) {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        color: "var(--fg-muted)",
        fontFamily: "var(--font-inter), sans-serif",
        fontSize: 16,
        lineHeight: 1.6,
      }}
    >
      {/* ─── NAV ─────────────────────────────────────────────────────── */}
      <nav
        className="sticky top-0 z-[10000]"
        style={{
          height: "var(--nav-h)",
          borderBottom: "1px solid var(--line)",
          background: "var(--overlay)",
          backdropFilter: "blur(14px)",
          WebkitBackdropFilter: "blur(14px)",
        }}
      >
        <Shell className="h-full">
          <div className="flex h-full items-center justify-between gap-4">
            <Link
              href="/"
              className="cursor-pointer font-bold uppercase"
              // Sized to match TerminalNavbar (the dashboard nav): 20px /
              // 0.14em. The two bars sit one click apart in the same session, so
              // a smaller marketing-weight logo on the home page read as a
              // different product rather than as the same one.
              style={{
                fontFamily: "var(--font-space-grotesk), sans-serif",
                fontSize: 20,
                letterSpacing: "0.14em",
                borderRadius: "var(--r-sm)",
              }}
            >
              <span style={{ color: "var(--accent)" }}>DEFI</span>
              <span style={{ color: "var(--fg-faint)" }}>/</span>
              <span style={{ color: "var(--fg)" }}>DESH</span>
            </Link>

            <div className="hidden md:flex" style={{ gap: "var(--space-3xl)" }}>
              {NAV.map((n) => (
                <Fragment key={n.href}>
                <Link
                  href={n.href}
                  className="cursor-pointer uppercase transition-colors hover:text-[var(--fg)]"
                  // 15px / 0.12em — TerminalNavbar's `tabBase`. Keep these two
                  // in step: they are the same navigation seen on two pages.
                  style={{
                    fontFamily: "var(--font-jetbrains-mono), monospace",
                    fontSize: 15,
                    letterSpacing: "0.12em",
                    color: "var(--fg-subtle)",
                    borderRadius: "var(--r-sm)",
                    transitionDuration: "var(--t-fast)",
                  }}
                >
                  {n.label}
                </Link>
                {/* Calculator sits immediately after Analytics rather than
                    after the whole list, hence rendering inside the map. */}
                {n.href === "/analytics" && <CalculatorMenu variant="inline" />}
                </Fragment>
              ))}
            </div>

            <div className="flex items-center" style={{ gap: "var(--space-md)" }}>
              <div
                className="hidden sm:flex items-center uppercase"
                // 13px matches TerminalNavbar's right-hand status badges
                // ("READ-ONLY · NON-CUSTODIAL"), so the pill stays proportional
                // to the now-larger nav links beside it.
                style={{
                  gap: "var(--space-md)",
                  padding: "5px 10px",
                  borderRadius: "var(--r-md)",
                  border: "1px solid var(--accent-line)",
                  background: "var(--accent-surface)",
                  fontFamily: "var(--font-jetbrains-mono), monospace",
                  fontSize: 13,
                  color: "var(--accent)",
                  letterSpacing: "0.12em",
                  whiteSpace: "nowrap",
                }}
              >
                <span className="relative flex h-1.5 w-1.5">
                  <span
                    className="absolute inline-flex h-full w-full animate-ping rounded-full"
                    style={{ background: "var(--accent)", opacity: 0.7 }}
                  />
                  <span
                    className="relative inline-flex h-1.5 w-1.5 rounded-full"
                    style={{ background: "var(--accent)" }}
                  />
                </span>
                Live
              </div>
              <ThemeToggle compact />
              <MobileNavMenu />
            </div>
          </div>
        </Shell>
      </nav>

      {/* ─── 1. HERO ─────────────────────────────────────────────────── */}
      <section
        className="relative overflow-hidden"
        style={{ borderBottom: "1px solid var(--line)" }}
      >
        <AmbientBackdrop />
        <Shell className="relative z-10">
          <div
            className="grid grid-cols-1 lg:grid-cols-2"
            style={{
              gap: "var(--space-4xl)",
              paddingBlock: "clamp(40px, 5vw, 64px)",
            }}
          >
            <div className="flex flex-col min-w-0">
              <HeroV2 />
              <HeroWalletConnect />
            </div>
            <div className="flex flex-col min-w-0" style={{ alignSelf: "stretch" }}>
              <DashboardPreview />
            </div>
          </div>
        </Shell>
      </section>

      {/* ─── 2. KEY METRICS ──────────────────────────────────────────── */}
      <Shell as="section">
        <TrustBand stats={trustStats} />
      </Shell>

      {/* ─── 3. LIVE MARKET DATA ─────────────────────────────────────── */}
      {/* Full-bleed border + surface, rail-aligned content — see `railed`. */}
      <PriceTickerStrip railed />

      {/* ─── 3b. SUPPORTED PROTOCOLS ─────────────────────────────────── */}
      <Shell as="section">
        <div style={{ paddingBlock: "var(--space-4xl)" }}>
          <SectionLabel meta="src: defillama">Supported Protocols</SectionLabel>
          <ProtocolScroll protocols={protocols} />
        </div>
      </Shell>

      {/* ─── 4. HOW IT WORKS ─────────────────────────────────────────── */}
      <Shell as="section">
        <div style={{ paddingTop: "var(--space-4xl)" }}>
          <SectionLabel meta="3 steps">How It Works</SectionLabel>
        </div>
        <HowItWorks />
      </Shell>

      {/* ─── 5. CAPABILITIES ─────────────────────────────────────────── */}
      <Shell as="section">
        <div style={{ paddingTop: "var(--space-4xl)" }}>
          <SectionLabel meta="what you get">Capabilities</SectionLabel>
        </div>
        <FeatureBento />
      </Shell>

      {/* ─── 6. CTA ──────────────────────────────────────────────────── */}
      <ShipNotifications railed />

      {/* ─── FOOTER ──────────────────────────────────────────────────── */}
      <Shell as="footer">
        <div
          className="flex flex-col md:flex-row items-start md:items-center md:justify-between"
          style={{
            gap: "var(--space-lg)",
            paddingBlock: "var(--space-2xl)",
            fontFamily: "var(--font-jetbrains-mono), monospace",
            fontSize: 12,
            letterSpacing: "0.08em",
            color: "var(--fg-subtle)",
          }}
        >
          <div>
            <span style={{ color: "var(--fg-muted)" }}>DEFIDESH</span> — DeFi
            Position Intelligence{" "}
            <span style={{ color: "var(--accent)" }}>//</span> v0.9.1-beta
          </div>
          <div className="flex" style={{ gap: "var(--space-2xl)" }}>
            <a
              href="https://github.com/Robicon0/lp-tracker"
              target="_blank"
              rel="noopener noreferrer"
              className="cursor-pointer transition-colors hover:text-[var(--fg)]"
            >
              GitHub
            </a>
            <Link
              href="/docs"
              className="cursor-pointer transition-colors hover:text-[var(--fg)]"
            >
              Docs
            </Link>
            <a
              href="https://x.com/defidesh"
              target="_blank"
              rel="noopener noreferrer"
              className="cursor-pointer transition-colors hover:text-[var(--fg)]"
            >
              @defidesh
            </a>
          </div>
          <div>© 2026 DefiDesh. Not financial advice.</div>
        </div>
      </Shell>
    </div>
  );
}
