"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowRight, LineChart, ShieldCheck } from "lucide-react";
import { DUR, EXPO_OUT } from "./motion";

const HEADLINE = [
  { t: "Track every", accent: false },
  { t: "DeFi position", accent: true },
  { t: "on one screen.", accent: false },
];

const MONO = "var(--font-jetbrains-mono), monospace";

/**
 * Home hero.
 *
 * TYPE — Space Grotesk carries the headline, Inter carries prose, and mono is
 * reserved for data, labels, and terminal chrome. Reserving mono is what makes
 * it read as a deliberate signal rather than a default; v1 set everything in
 * mono, which flattened the hierarchy to nothing.
 *
 * The headline reveals line-by-line, not letter-by-letter. At display sizes
 * per-letter staggering reads as noise and delays comprehension of the one
 * thing above the fold that has to land immediately.
 *
 * COLOUR — every value is a token, including the CTA fills, so the hero is
 * legible in light mode without a single mode-specific branch.
 */
export default function HeroV2() {
  const reduce = useReducedMotion();

  const line = (i: number) =>
    reduce
      ? {}
      : {
          initial: { opacity: 0, y: 26 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: DUR.slow, ease: EXPO_OUT, delay: 0.04 + i * 0.08 },
        };

  const fade = (delay: number) =>
    reduce
      ? {}
      : {
          initial: { opacity: 0, y: 12 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: DUR.base, ease: EXPO_OUT, delay },
        };

  return (
    <div className="flex flex-col min-w-0">
      {/* Eyebrow */}
      <motion.div
        {...fade(0)}
        className="flex items-center uppercase"
        style={{
          gap: "var(--space-md)",
          marginBottom: "var(--space-xl)",
          fontFamily: MONO,
          fontSize: 12,
          letterSpacing: "0.22em",
          color: "var(--fg-subtle)",
          whiteSpace: "nowrap",
        }}
      >
        <span
          className="inline-block rounded-full"
          style={{
            width: 6,
            height: 6,
            background: "var(--accent)",
            boxShadow: "0 0 10px var(--accent-glow)",
          }}
        />
        DeFi Position Intelligence
      </motion.div>

      {/* Headline */}
      <h1
        style={{
          fontFamily: "var(--font-space-grotesk), sans-serif",
          fontWeight: 700,
          fontSize: "clamp(40px, 4.8vw, 70px)",
          lineHeight: 1.05,
          letterSpacing: "-0.035em",
          color: "var(--fg)",
          marginBottom: "var(--space-2xl)",
        }}
      >
        {HEADLINE.map((seg, i) => (
          <motion.span key={i} {...line(i)} className="block">
            <span style={seg.accent ? { color: "var(--accent)" } : undefined}>
              {seg.t}
            </span>
          </motion.span>
        ))}
      </h1>

      {/* Body — measure capped near 46ch for comfortable reading */}
      <motion.p
        {...fade(0.28)}
        style={{
          fontFamily: "var(--font-inter), sans-serif",
          fontSize: 16.5,
          lineHeight: 1.68,
          color: "var(--fg-muted)",
          maxWidth: "46ch",
          marginBottom: "var(--space-2xl)",
        }}
      >
        Real-time liquidity tracking across EVM, Solana, and Sui. Value, APY,
        fees, and impermanent loss — reconciled against on-chain truth, not
        estimates.
      </motion.p>

      {/* CTAs — 46px min target, token-driven fills, visible focus ring */}
      <motion.div
        {...fade(0.36)}
        className="flex flex-wrap"
        style={{ gap: "var(--space-lg)", marginBottom: "var(--space-2xl)" }}
      >
        <Link
          href="/dashboard"
          className="group inline-flex items-center cursor-pointer font-bold uppercase transition-colors"
          style={{
            gap: "var(--space-lg)",
            paddingInline: "var(--space-2xl)",
            minHeight: 46,
            borderRadius: "var(--r-md)",
            background: "var(--accent)",
            color: "var(--accent-fg)",
            fontFamily: MONO,
            fontSize: 13.5,
            letterSpacing: "0.1em",
            transitionDuration: "var(--t-fast)",
          }}
        >
          Go to Dashboard
          <ArrowRight
            size={15}
            strokeWidth={2.5}
            className="transition-transform group-hover:translate-x-1"
            style={{ transitionDuration: "var(--t-fast)" }}
          />
        </Link>
        <Link
          href="/analytics"
          className="group inline-flex items-center cursor-pointer font-bold uppercase transition-colors"
          style={{
            gap: "var(--space-lg)",
            paddingInline: "var(--space-2xl)",
            minHeight: 46,
            borderRadius: "var(--r-md)",
            border: "1px solid var(--line-strong)",
            background: "var(--surface)",
            color: "var(--fg)",
            fontFamily: MONO,
            fontSize: 13.5,
            letterSpacing: "0.1em",
            transitionDuration: "var(--t-fast)",
          }}
        >
          <LineChart size={15} strokeWidth={2.5} style={{ color: "var(--info)" }} />
          View Analytics
        </Link>
      </motion.div>

      {/* Trust line — sits next to the wallet prompt it reassures, rather than
          being buried in the nav bar where nobody reads it. */}
      <motion.div
        {...fade(0.44)}
        className="flex items-start"
        style={{
          gap: "var(--space-md)",
          marginBottom: "var(--space-2xl)",
          fontFamily: MONO,
          fontSize: 12,
          lineHeight: 1.6,
          letterSpacing: "0.04em",
          color: "var(--fg-subtle)",
        }}
      >
        <ShieldCheck
          size={14}
          strokeWidth={2}
          className="shrink-0"
          style={{ color: "var(--accent)", marginTop: 2 }}
        />
        Read-only and non-custodial. No signatures, no approvals, no key access.
      </motion.div>
    </div>
  );
}
