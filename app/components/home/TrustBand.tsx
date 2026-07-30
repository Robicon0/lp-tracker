"use client";

import AnimatedCount from "../AnimatedCount";
import { Reveal, RevealItem } from "./Reveal";

export type TrustStat = {
  label: string;
  value: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  note: string;
};

/**
 * Key-metrics band — step 2 of the "Real-Time / Operations Landing" pattern.
 *
 * Four equal cells on one row at desktop, 2x2 at tablet, stacked on phone —
 * so the grid always divides evenly and never leaves an orphan cell spanning
 * a half-empty row.
 *
 * Every figure derives from the DeFiLlama data the page already fetches at
 * request time. Nothing here is a rounded marketing number, which is the point
 * of a proof band on a product whose entire pitch is measurement accuracy.
 */
export default function TrustBand({ stats }: { stats: TrustStat[] }) {
  return (
    <Reveal className="grid grid-cols-2 lg:grid-cols-4">
      {stats.map((s, i) => (
        <RevealItem
          key={s.label}
          className="transition-colors duration-200 hover:bg-[var(--surface)]"
          style={{
            padding: "var(--space-3xl) var(--space-2xl)",
            borderRight:
              i % 2 === 0 || i < stats.length - 1
                ? "1px solid var(--line)"
                : undefined,
            borderBottom: "1px solid var(--line)",
          }}
        >
          <div
            className="uppercase"
            style={{
              fontFamily: "var(--font-jetbrains-mono), monospace",
              fontSize: 11,
              letterSpacing: "0.2em",
              color: "var(--fg-subtle)",
              marginBottom: "var(--space-lg)",
            }}
          >
            {s.label}
          </div>
          <div
            style={{
              fontFamily: "var(--font-space-grotesk), sans-serif",
              fontWeight: 600,
              fontSize: "clamp(26px, 2.9vw, 38px)",
              letterSpacing: "-0.03em",
              lineHeight: 1,
              color: "var(--fg)",
              marginBottom: "var(--space-lg)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            <AnimatedCount
              target={s.value}
              prefix={s.prefix}
              suffix={s.suffix}
              decimals={s.decimals ?? 0}
            />
          </div>
          <div
            style={{
              fontFamily: "var(--font-inter), sans-serif",
              fontSize: 13,
              lineHeight: 1.6,
              color: "var(--fg-subtle)",
              maxWidth: "34ch",
            }}
          >
            {s.note}
          </div>
        </RevealItem>
      ))}
    </Reveal>
  );
}
