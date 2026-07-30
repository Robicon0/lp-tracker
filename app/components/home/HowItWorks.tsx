"use client";

import { Wallet, Radar, BarChart3 } from "lucide-react";
import { Reveal, RevealItem } from "./Reveal";

const STEPS = [
  {
    n: "01",
    Icon: Wallet,
    title: "Point us at an address",
    body: "Connect a wallet, save a watched address, or paste one in. All three entry paths resolve to the same positions — nothing is gated behind a connection.",
  },
  {
    n: "02",
    Icon: Radar,
    title: "We reconstruct the ledger",
    body: "Open positions come from on-chain state. Closed ones are rebuilt from transaction history — burned NFTs, destroyed objects, reclaimed accounts — and priced at their claim date.",
  },
  {
    n: "03",
    Icon: BarChart3,
    title: "You get one reconciled view",
    body: "Value, fees, APY, impermanent loss, and realised capital gain across every chain, summed once and traceable back to the events that produced them.",
  },
];

/**
 * How it works — step 3 of the "Real-Time / Operations Landing" pattern.
 *
 * Three equal columns, deliberately. The previous asymmetric bento made two
 * cells visually louder than the others, which is right for a feature grid
 * (some features matter more) but wrong for a sequence: in an ordered process,
 * unequal weight implies unequal importance and breaks the read order.
 */
export default function HowItWorks() {
  return (
    <Reveal className="grid grid-cols-1 md:grid-cols-3">
      {STEPS.map((s, i) => (
        <RevealItem
          key={s.n}
          className="group relative"
          style={{
            padding: "var(--space-3xl) var(--space-2xl)",
            borderRight: i < STEPS.length - 1 ? "1px solid var(--line)" : undefined,
            borderBottom: "1px solid var(--line)",
          }}
        >
          <div className="flex items-center gap-3" style={{ marginBottom: "var(--space-xl)" }}>
            <span
              style={{
                display: "grid",
                placeItems: "center",
                width: 34,
                height: 34,
                borderRadius: "var(--r-md)",
                border: "1px solid var(--accent-line)",
                background: "var(--accent-surface)",
                color: "var(--accent)",
              }}
            >
              <s.Icon size={16} strokeWidth={1.9} />
            </span>
            <span
              style={{
                fontFamily: "var(--font-jetbrains-mono), monospace",
                fontSize: 11,
                letterSpacing: "0.2em",
                color: "var(--fg-subtle)",
              }}
            >
              STEP {s.n}
            </span>
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
            {s.title}
          </h3>
          <p
            style={{
              fontFamily: "var(--font-inter), sans-serif",
              fontSize: 14,
              lineHeight: 1.7,
              color: "var(--fg-muted)",
            }}
          >
            {s.body}
          </p>
        </RevealItem>
      ))}
    </Reveal>
  );
}
