"use client";

import { useState } from "react";

export type ProtocolScrollItem = {
  name: string;
  type: "LP" | "Lending";
  chain: string;
  tvl: number | null;
  volume24h: number | null;
  isDex: boolean;
};

function fmtBig(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

// Seamless infinite left-scroll, paused on hover. The list is TRIPLED
// (not doubled) and animated to translateX(-33.333%) so the wrap point
// always lands on an exact copy of the leftmost content AND the visible
// content beyond a single-copy width stays inside the rendered tracked
// area on viewports up to ~2 × single-copy-width (≈3854px for 8 cards at
// 240px — covers up to 4K displays without exposing the parent's dark
// background as an empty gap on the right edge before wrap).
export default function ProtocolScroll({
  protocols,
}: {
  protocols: ProtocolScrollItem[];
}) {
  const [paused, setPaused] = useState(false);
  const tripled = [...protocols, ...protocols, ...protocols];

  return (
    <>
      <style
        dangerouslySetInnerHTML={{
          __html:
            "@keyframes defidesh-protocols { 0% { transform: translateX(0); } 100% { transform: translateX(-33.3333%); } }",
        }}
      />
      <div
        className="protocol-scroll-container overflow-hidden border border-[var(--line)] bg-[var(--line)]"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
      >
        <div
          className="protocol-scroll-inner flex gap-px"
          style={{
            width: "max-content",
            animation: "defidesh-protocols 45s linear infinite",
            animationPlayState: paused ? "paused" : "running",
          }}
        >
          {tripled.map((p, i) => (
            <div
              key={`${p.name}-${i}`}
              data-copy={i < protocols.length ? "original" : "duplicate"}
              className="protocol-scroll-card p-5 transition-colors flex flex-col gap-2.5 flex-shrink-0"
              style={{
                width: 240,
                background: "var(--surface)",
              }}
            >
              <div className="text-[12px] text-[var(--accent)] tracking-[0.1em]">
                [{p.type.toUpperCase()}]
              </div>
              <div>
                <div className="text-[16px] font-bold text-[var(--fg)]">{p.name}</div>
                <div className="text-[12px] text-[var(--fg-subtle)] uppercase tracking-[0.1em] mt-0.5">
                  {p.chain}
                </div>
              </div>
              <div className="flex flex-col gap-1.5 mt-1">
                <div className="flex justify-between items-baseline text-[12px]">
                  <span className="text-[var(--fg-subtle)] tracking-[0.06em]">TVL</span>
                  <span className="text-[var(--accent)] font-bold tabular-nums">
                    {fmtBig(p.tvl)}
                  </span>
                </div>
                <div className="flex justify-between items-baseline text-[12px]">
                  <span className="text-[var(--fg-subtle)] tracking-[0.06em]">VOL 24H</span>
                  <span
                    className={`font-bold tabular-nums ${p.isDex ? "text-[var(--accent)]" : "text-[var(--fg-subtle)]"}`}
                  >
                    {p.isDex ? fmtBig(p.volume24h) : "n/a"}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
