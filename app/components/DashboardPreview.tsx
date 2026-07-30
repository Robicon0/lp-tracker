"use client";

import { useState, useEffect } from "react";

function AnimatedCounter({
  target,
  prefix = "",
  suffix = "",
  decimals = 0,
  durationMs = 1400,
}: {
  target: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  durationMs?: number;
}) {
  const [val, setVal] = useState(target * 0.7);
  useEffect(() => {
    let start: number | null = null;
    let raf = 0;
    const from = target * 0.7;
    const step = (ts: number) => {
      if (start === null) start = ts;
      const p = Math.min((ts - start) / durationMs, 1);
      const ease = 1 - Math.pow(1 - p, 3);
      setVal(from + (target - from) * ease);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return (
    <>
      {prefix}
      {val.toLocaleString("en-US", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })}
      {suffix}
    </>
  );
}

function LiveFlicker({
  base,
  variance,
  suffix = "",
  decimals = 1,
}: {
  base: number;
  variance: number;
  suffix?: string;
  decimals?: number;
}) {
  const [val, setVal] = useState(base);
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      setVal(base + (Math.random() - 0.5) * variance);
      timer = setTimeout(tick, 1800 + Math.random() * 1200);
    };
    let timer = setTimeout(tick, 1800 + Math.random() * 1200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [base, variance]);
  return (
    <>
      {val.toLocaleString("en-US", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })}
      {suffix}
    </>
  );
}

const ALLOC = [
  { pct: 35, color: "var(--accent)", label: "Uniswap" },
  { pct: 26, color: "var(--info)", label: "Orca" },
  { pct: 20, color: "var(--chain-solana)", label: "Aave" },
  { pct: 12, color: "var(--chain-sui)", label: "Morpho" },
  { pct: 7, color: "var(--neg)", label: "Cetus" },
];

function Donut() {
  const r = 38;
  const cx = 50;
  const cy = 50;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  const slices = ALLOC.map((d) => {
    const dash = (d.pct / 100) * circ;
    const slice = { ...d, offset, dash };
    offset += dash;
    return slice;
  });
  return (
    <div className="flex flex-col">
      <div className="flex justify-center mb-3">
        <svg width="90" height="90" viewBox="0 0 100 100">
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--surface-2)" strokeWidth="14" />
          {slices.map((s, i) => (
            <circle
              key={i}
              cx={cx}
              cy={cy}
              r={r}
              fill="none"
              stroke={s.color}
              strokeWidth="14"
              strokeDasharray={`${s.dash} ${circ - s.dash}`}
              strokeDashoffset={-s.offset}
              transform="rotate(-90 50 50)"
            />
          ))}
          <text
            x="50"
            y="48"
            textAnchor="middle"
            fill="var(--fg)"
            fontSize="11"
            fontWeight="600"
            style={{ fontFamily: "var(--font-jetbrains-mono)" }}
          >
            ALLOC
          </text>
          <text
            x="50"
            y="58"
            textAnchor="middle"
            fill="var(--fg-subtle)"
            fontSize="8"
            style={{ fontFamily: "var(--font-jetbrains-mono)" }}
          >
            7 pools
          </text>
        </svg>
      </div>
      <div className="flex flex-col gap-1.5">
        {ALLOC.map((d, i) => (
          <div key={i} className="flex items-center gap-1.5 text-[11px]">
            <div className="w-1.5 h-1.5 flex-shrink-0" style={{ background: d.color }} />
            <div className="text-[var(--fg-subtle)] flex-1 truncate">{d.label}</div>
            <div className="text-[var(--fg)] tabular-nums">{d.pct}%</div>
          </div>
        ))}
      </div>
    </div>
  );
}

const POSITIONS: { name: string; proto: string; val: string; apy: string; pnl: string; up: boolean }[] = [
  { name: "ETH/USDC", proto: "UNISWAP", val: "$42,180", apy: "18.4%", pnl: "+$812", up: true },
  { name: "ETH/BTC", proto: "UNISWAP", val: "$31,400", apy: "22.1%", pnl: "+$1,204", up: true },
  { name: "SOL/USDC", proto: "ORCA", val: "$28,900", apy: "4.8%", pnl: "+$338", up: true },
  { name: "CBBTC/USDC", proto: "AERO", val: "$19,500", apy: "9.2%", pnl: "+$220", up: true },
  { name: "SUI/USDC", proto: "CETUS", val: "$11,200", apy: "31.7%", pnl: "-$88", up: false },
];

export default function DashboardPreview() {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignSelf: "stretch" }}>
      {/* Panel header */}
      <div className="flex items-center justify-between border-b border-[var(--line)] pb-3 mb-3">
        <span className="text-[12px] text-[var(--fg-subtle)] tracking-[0.15em] uppercase">
          {"// portfolio_overview.live"}
        </span>
        <span className="flex items-center gap-1.5 text-[12px] text-[var(--accent)] tracking-[0.1em]">
          <span className="inline-block w-[5px] h-[5px] bg-[var(--accent)] animate-pulse" />
          LIVE
        </span>
      </div>

      <div
        className="border border-[var(--line)] bg-[var(--surface)] flex flex-col"
        style={{ flex: 1 }}
      >
        {/* Top metrics */}
        <div className="grid grid-cols-3 border-b border-[var(--line)]">
          <div className="ddp-top-stat-cell p-5 border-r border-[var(--line)]">
            <div className="ddp-top-stat-label text-[11px] text-[var(--fg-subtle)] tracking-[0.15em] uppercase mb-2">Total Value</div>
            <div className="ddp-top-stat-value text-[32px] font-bold text-[var(--fg)] tracking-[-0.02em] tabular-nums">
              <AnimatedCounter target={133180} prefix="$" decimals={0} />
            </div>
            <div className="ddp-top-stat-delta text-[12px] text-[var(--accent)] mt-1">▲ +$2,574 (24h)</div>
          </div>
          <div className="ddp-top-stat-cell p-5 border-r border-[var(--line)]">
            <div className="ddp-top-stat-label text-[11px] text-[var(--fg-subtle)] tracking-[0.15em] uppercase mb-2">Avg APY</div>
            <div className="ddp-top-stat-value text-[32px] font-bold text-[var(--accent)] tracking-[-0.02em] tabular-nums">
              <LiveFlicker base={16.4} variance={0.8} suffix="%" decimals={1} />
            </div>
            <div className="ddp-top-stat-delta text-[12px] text-[var(--accent)] mt-1">▲ +0.3% (7d)</div>
          </div>
          <div className="ddp-top-stat-cell p-5">
            <div className="ddp-top-stat-label text-[11px] text-[var(--fg-subtle)] tracking-[0.15em] uppercase mb-2">Positions</div>
            <div className="ddp-top-stat-value text-[32px] font-bold text-[var(--info)] tracking-[-0.02em]">5</div>
            <div className="ddp-top-stat-delta text-[12px] text-[var(--fg-subtle)] mt-1">across 3 chains</div>
          </div>
        </div>

        {/* Body: positions + alloc */}
        <div
          className="ddp-body grid border-b border-[var(--line)]"
          style={{ gridTemplateColumns: "1fr 160px", flex: 1 }}
        >
          <div className="ddp-positions border-r border-[var(--line)]">
            <div
              className="ddp-pos-header grid gap-2 py-3 px-4 border-b border-[var(--line)] text-[11px] text-[var(--fg-subtle)] tracking-[0.15em] uppercase"
              style={{ gridTemplateColumns: "2fr 1fr 1fr 1fr" }}
            >
              <span>Position</span>
              <span className="text-right">Value</span>
              <span className="text-right">APY</span>
              <span className="ddp-pos-pnl text-right">P&amp;L</span>
            </div>
            {POSITIONS.map((p, i) => (
              <div
                key={i}
                className={`ddp-pos-row grid gap-2 py-2.5 px-4 text-[14px] items-center hover:bg-[var(--surface-hover)] transition-colors ${i < POSITIONS.length - 1 ? "border-b border-[var(--line)]" : ""}`}
                style={{ gridTemplateColumns: "2fr 1fr 1fr 1fr" }}
              >
                <div>
                  <div className="text-[var(--fg)] font-medium">{p.name}</div>
                  <div className="text-[11px] text-[var(--fg-subtle)] tracking-[0.08em]">{p.proto}</div>
                </div>
                <div className="text-right text-[var(--fg-muted)] tabular-nums">{p.val}</div>
                <div className="text-right text-[var(--accent)] tabular-nums">{p.apy}</div>
                <div
                  className={`ddp-pos-pnl text-right tabular-nums ${p.up ? "text-[var(--accent)]" : "text-[var(--neg)]"}`}
                >
                  {p.pnl}
                </div>
              </div>
            ))}
          </div>
          <div className="p-4 flex flex-col">
            <div className="text-[11px] text-[var(--fg-subtle)] tracking-[0.15em] uppercase mb-3">Allocation</div>
            <Donut />
          </div>
        </div>

        {/* Cashflow */}
        <div className="ddp-cashflow grid grid-cols-4 border-b border-[var(--line)]">
          <div className="ddp-cashflow-cell p-3.5 border-r border-[var(--line)]">
            <div className="text-[11px] text-[var(--fg-subtle)] tracking-[0.12em] uppercase mb-1.5">Daily Yield</div>
            <div className="text-[17px] font-semibold text-[var(--accent)] tabular-nums">+$59.84</div>
          </div>
          <div className="ddp-cashflow-cell p-3.5 border-r border-[var(--line)]">
            <div className="text-[11px] text-[var(--fg-subtle)] tracking-[0.12em] uppercase mb-1.5">Weekly</div>
            <div className="text-[17px] font-semibold text-[var(--accent)] tabular-nums">+$418.91</div>
          </div>
          <div className="ddp-cashflow-cell p-3.5 border-r border-[var(--line)]">
            <div className="text-[11px] text-[var(--fg-subtle)] tracking-[0.12em] uppercase mb-1.5">Monthly</div>
            <div className="text-[17px] font-semibold text-[var(--info)] tabular-nums">+$1,820</div>
          </div>
          <div className="ddp-cashflow-cell p-3.5">
            <div className="text-[11px] text-[var(--fg-subtle)] tracking-[0.12em] uppercase mb-1.5">Unrealized</div>
            <div className="text-[17px] font-semibold text-[var(--fg-muted)] tabular-nums">+$2,486</div>
          </div>
        </div>

        {/* Footer chains */}
        <div className="flex items-center gap-6 px-4 py-2.5 text-[11px] text-[var(--fg-subtle)]">
          <div className="flex items-center gap-1.5">
            <div className="w-[5px] h-[5px] bg-[var(--info)]" />
            <span>EVM</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-[5px] h-[5px] bg-[var(--chain-solana)]" />
            <span>SOLANA</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-[5px] h-[5px] bg-[var(--chain-sui)]" />
            <span>SUI</span>
          </div>
          <div className="flex-1" />
          <span>Updated 3s ago</span>
        </div>
      </div>
    </div>
  );
}
