"use client";

import { Layers3, Activity, Percent, GitBranch } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Reveal, RevealItem } from "./Reveal";

type Feature = {
  icon: LucideIcon;
  title: string;
  desc: string;
  tone: "accent" | "info";
};

const FEATURES: Feature[] = [
  {
    icon: Layers3,
    title: "Cross-Chain Aggregation",
    desc: "Ethereum, Base, Arbitrum, Optimism, Polygon, HyperEVM, Solana, and Sui in a single view — no chain switching, no per-chain tabs.",
    tone: "accent",
  },
  {
    icon: Activity,
    title: "Real-Time P&L",
    desc: "Unrealised gains, accrued fees, and impermanent loss, recomputed as blocks land rather than on a refresh interval.",
    tone: "info",
  },
  {
    icon: Percent,
    title: "APY Intelligence",
    desc: "Composite yield across base rates, incentives, and fee income — with a derived fallback for pools no aggregator indexes.",
    tone: "info",
  },
  {
    icon: GitBranch,
    title: "Closed Positions Included",
    desc: "Rebuilt from chain history and priced at claim date, never at today's spot. Most trackers show you nothing here at all.",
    tone: "accent",
  },
];

/**
 * Capability grid — 2x2, symmetric.
 *
 * Previously an asymmetric bento (2-1 / 1-2). Symmetry was chosen here for a
 * concrete reason rather than taste: all four capabilities are peers a user
 * evaluates side by side, and unequal cell weight in a comparison grid biases
 * the read before the user has read anything. Uneven spans are for editorial
 * hierarchy, not for feature parity tables.
 *
 * Icons are Lucide SVG, never typographic glyphs — glyphs inherit font metrics,
 * resist consistent optical sizing, and get announced by screen readers.
 */
export default function FeatureBento() {
  return (
    <Reveal className="grid grid-cols-1 md:grid-cols-2">
      {FEATURES.map((f, i) => {
        const Icon = f.icon;
        const tone = f.tone === "accent" ? "var(--accent)" : "var(--info)";
        return (
          <RevealItem
            key={f.title}
            className="group relative"
            style={{
              padding: "var(--space-3xl) var(--space-2xl)",
              borderRight: i % 2 === 0 ? "1px solid var(--line)" : undefined,
              borderBottom: "1px solid var(--line)",
            }}
          >
            {/* Hover hairline — a zero-layout-cost affordance that binds the
                cell together as one unit. */}
            <span
              aria-hidden
              className="absolute left-0 top-0 h-px w-0 transition-all duration-500 ease-out group-hover:w-full"
              style={{ background: tone, opacity: 0.5 }}
            />

            <div
              style={{
                display: "inline-grid",
                placeItems: "center",
                width: 38,
                height: 38,
                borderRadius: "var(--r-md)",
                border: `1px solid ${tone}`,
                background: "var(--surface)",
                color: tone,
                marginBottom: "var(--space-xl)",
              }}
            >
              <Icon size={17} strokeWidth={1.9} />
            </div>

            <h3
              style={{
                fontFamily: "var(--font-space-grotesk), sans-serif",
                fontWeight: 600,
                fontSize: 18,
                letterSpacing: "-0.01em",
                color: "var(--fg)",
                marginBottom: "var(--space-lg)",
              }}
            >
              {f.title}
            </h3>
            <p
              style={{
                fontFamily: "var(--font-inter), sans-serif",
                fontSize: 14,
                lineHeight: 1.7,
                color: "var(--fg-muted)",
                maxWidth: "52ch",
              }}
            >
              {f.desc}
            </p>
          </RevealItem>
        );
      })}
    </Reveal>
  );
}
