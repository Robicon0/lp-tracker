"use client";

import { useEffect, useState } from "react";
import { Shell } from "./home/Shell";

// NOTE: the strip deliberately carries NO protocol/chain counts. It used to lead
// with "7 PROTOCOLS | 3 CHAINS", which (a) duplicated the metrics band and the
// protocol grid immediately above and below it, and (b) drifted out of sync with
// them — the band reports 8 chains from app/page.tsx's CHAIN_COUNT while this
// file's hardcoded copy still said 3. If a count belongs on the page it belongs
// in TrustBand, where it is derived rather than hardcoded.

// Symbol displayed in the ticker → CoinGecko ID used for live price lookup.
// IMPORTANT: this component fetches LIVE prices from /api/prices on mount and
// every 60s. NEVER hardcode prices here or anywhere in the ticker pipeline.
// WBTC/CBBTC use their own per-wrapper CG IDs ('wrapped-bitcoin' /
// 'coinbase-wrapped-btc') for accurate per-asset prices. This intentionally
// differs from SYMBOL_TO_CG_ID in app/hooks/useWalletTokens.ts which aliases
// every BTC wrapper to 'bitcoin' for wallet-balance aggregation (see CLAUDE.md).
export const TICKER_TOKENS: { sym: string; id: string }[] = [
  { sym: "BTC",   id: "bitcoin" },
  { sym: "WBTC",  id: "wrapped-bitcoin" },
  { sym: "CBBTC", id: "coinbase-wrapped-btc" },
  { sym: "ETH",   id: "ethereum" },
  { sym: "SOL",   id: "solana" },
  { sym: "SUI",   id: "sui" },
  { sym: "ARB",   id: "arbitrum" },
  { sym: "AERO",  id: "aerodrome-finance" },
  { sym: "UNI",   id: "uniswap" },
  { sym: "TAO",   id: "bittensor" },
  { sym: "ZCASH", id: "zcash" },
  { sym: "HYPE",  id: "hyperliquid" },
  { sym: "BNB",   id: "binancecoin" },
];

type CoinPrice = { usd?: number; usd_24h_change?: number };
type PriceMap = Record<string, CoinPrice>;

const REFRESH_MS = 60_000;

function formatPrice(usd: number): string {
  if (usd >= 1) {
    return usd.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  return usd.toLocaleString("en-US", {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  });
}

function formatChange(chg: number): string {
  const sign = chg >= 0 ? "+" : "";
  return `${sign}${chg.toFixed(2)}%`;
}

/**
 * `railed` (Home v2) puts the ENTIRE strip on the page rail — border, surface
 * fill, and content all stop at `--maxw` / `--gutter` via <Shell> — so the strip
 * reads as a component in the same column as the metrics band above and the
 * protocol grid below.
 *
 * Do NOT full-bleed the border/background while railing only the content: the
 * band's top rule then runs several hundred px past the metrics band's own
 * (railed) bottom rule, so the two read as one line that overshoots and stops
 * mid-air, and the surface fill leaves a tall empty bar on each side of the
 * content.
 *
 * The railed strip carries `border-b` only, not `border-y`: it sits flush under
 * the metrics band, whose cells already draw a railed `border-bottom`. A top
 * border would stack two 1px rules into a heavy 2px seam. If this strip is ever
 * moved somewhere without a ruled section above it, restore the top border.
 *
 * Legacy home (`railed` omitted) keeps the original edge-to-edge
 * `px-4 sm:px-12` treatment, which its own un-railed sections align to.
 */
export default function PriceTickerStrip({ railed = false }: { railed?: boolean } = {}) {
  const [prices, setPrices] = useState<PriceMap>({});
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const ids = TICKER_TOKENS.map((t) => t.id).join(",");
    const url = `/api/prices?endpoint=simple/price&ids=${ids}&vs_currencies=usd&include_24hr_change=true`;

    async function fetchPrices() {
      try {
        const res = await fetch(url);
        if (!res.ok || cancelled) return;
        const data: unknown = await res.json();
        if (cancelled) return;
        if (data && typeof data === "object" && !("error" in (data as object))) {
          // Merge with previous state so a partial-failure response (a single
          // missing token) doesn't drop tokens whose last known price we still
          // hold. Matches the "show the last known price or skip" rule.
          setPrices((prev) => ({ ...prev, ...(data as PriceMap) }));
        }
      } catch (err) {
        console.error("[PriceTickerStrip] fetch error:", err);
      }
    }

    fetchPrices();
    const tid = setInterval(fetchPrices, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(tid);
    };
  }, []);

  // Skip tokens we have no price for yet. On initial mount this is empty so
  // the strip renders zero items until the first fetch resolves (typically
  // <500ms). Never substitute a hardcoded fallback.
  const items = TICKER_TOKENS.flatMap((t) => {
    const d = prices[t.id];
    if (!d || typeof d.usd !== "number") return [];
    const chg = typeof d.usd_24h_change === "number" ? d.usd_24h_change : null;
    return [
      {
        sym: t.sym,
        price: formatPrice(d.usd),
        chg: chg === null ? null : formatChange(chg),
        up: chg === null ? null : chg >= 0,
      },
    ];
  });

  // TRIPLED list (not doubled) animated to translateX(-33.333%) so the wrap
  // point always lands inside the rendered content even on ultrawide viewports
  // (up to ~2 × single-copy width). Per-item marginRight (NOT flex gap) is
  // mathematically required for perfect seamless wrap: with `gap` the doubled
  // sibling separator is half-gap offset from the loop point (1/3 × 40px ≈
  // 13px visible jump at K=3); marginRight on every item INCLUDING the last
  // of copy 3 produces zero misalignment.
  const tripled = [...items, ...items, ...items];

  const row = (
    <>
      {/* Leading label. `pr-*` only, no left padding — it is the first cell, so
          its text starts on the strip's own inline padding, which is what puts
          it on the same vertical line as the labels in the metrics band. */}
      <div className="pts-live flex items-center gap-2 pr-6 sm:pr-8 border-r border-[var(--line)] whitespace-nowrap">
        <span className="inline-block w-[5px] h-[5px] bg-[var(--accent)] animate-pulse" />
        <span className="text-[var(--info)] uppercase tracking-[0.12em] text-[14px]">
          LIVE Prices
        </span>
      </div>
      {/* pl-8 lives on the outer container, NOT the animated div, so the
          inner tripled list is perfectly symmetric. */}
      <div
        className="pts-scroll flex-1 overflow-hidden flex items-center pl-8"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
      >
        <div
          className="flex whitespace-nowrap"
          style={{
            width: "max-content",
            animation: "defidesh-ticker 50s linear infinite",
            animationPlayState: paused ? "paused" : "running",
          }}
        >
          {tripled.map((t, i) => (
            <div
              key={i}
              className="text-[14px] flex gap-2 items-center"
              style={{ marginRight: 40 }}
            >
              <span className="text-[var(--fg-subtle)]">{t.sym}</span>
              <span className="text-[var(--fg)] tabular-nums">${t.price}</span>
              {t.chg !== null && (
                <span
                  className={`tabular-nums ${t.up ? "text-[var(--accent)]" : "text-[var(--neg)]"}`}
                >
                  {t.chg}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );

  return (
    <>
      <style
        dangerouslySetInnerHTML={{
          __html:
            "@keyframes defidesh-ticker { 0% { transform: translateX(0); } 100% { transform: translateX(-33.3333%); } }",
        }}
      />
      {railed ? (
        <Shell>
          <div
            className="border-b border-[var(--line)] h-12 overflow-hidden flex items-stretch"
            style={{
              background: "var(--surface)",
              // Matches the metrics cells' inline padding above, so the leading
              // label starts on the same vertical line as "TVL INDEXED" rather
              // than 24px to its left. `overflow-hidden` clips at the padding
              // box, so the scrolling prices still terminate at the strip edge.
              paddingInline: "var(--space-2xl)",
            }}
          >
            {row}
          </div>
        </Shell>
      ) : (
        <div
          className="border-y border-[var(--line)] px-4 sm:px-12 flex items-stretch h-12 overflow-hidden"
          style={{ background: "var(--surface)" }}
        >
          {row}
        </div>
      )}
    </>
  );
}
