"use client";

import { useEffect, useState } from "react";

const PROTOCOL_COUNT = 7;
const CHAIN_COUNT = 3;

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

export default function PriceTickerStrip() {
  const [prices, setPrices] = useState<PriceMap>({});

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

  const doubled = [...items, ...items];

  return (
    <>
      <style
        dangerouslySetInnerHTML={{
          __html:
            "@keyframes defidesh-ticker { 0% { transform: translateX(0); } 100% { transform: translateX(-50%); } }",
        }}
      />
      <div className="border-b border-[#1f1f1f] px-4 sm:px-12 flex items-stretch h-12 overflow-hidden">
        <div className="flex items-center gap-2.5 pr-6 sm:pr-8 border-r border-[#1f1f1f] whitespace-nowrap">
          <span className="text-[#00ff41] font-bold text-[16px] tabular-nums">
            {PROTOCOL_COUNT}
          </span>
          <span className="text-[#888] uppercase tracking-[0.12em] text-[14px]">Protocols</span>
        </div>
        <div className="flex items-center gap-2.5 px-6 sm:px-8 border-r border-[#1f1f1f] whitespace-nowrap">
          <span className="text-[#00ff41] font-bold text-[16px] tabular-nums">
            {CHAIN_COUNT}
          </span>
          <span className="text-[#888] uppercase tracking-[0.12em] text-[14px]">Chains</span>
        </div>
        <div className="flex items-center gap-2 px-8 border-r border-[#1f1f1f] whitespace-nowrap">
          <span className="inline-block w-[5px] h-[5px] bg-[#00ff41] animate-pulse" />
          <span className="text-[#00e5ff] uppercase tracking-[0.12em] text-[14px]">
            LIVE Prices
          </span>
        </div>
        {/* pl-8 lives on the outer container, NOT the animated div, so the
            inner doubled list is perfectly symmetric. With the padding on the
            inner div, translateX(-50%) lands on "32px-then-item" instead of
            "item-immediately", producing a visible snap each loop. */}
        <div className="flex-1 overflow-hidden flex items-center pl-8">
          <div
            className="flex gap-10 whitespace-nowrap"
            style={{ animation: "defidesh-ticker 50s linear infinite" }}
          >
            {doubled.map((t, i) => (
              <div key={i} className="text-[14px] flex gap-2 items-center">
                <span className="text-[#888]">{t.sym}</span>
                <span className="text-[#e8e8e8] tabular-nums">${t.price}</span>
                {t.chg !== null && (
                  <span
                    className={`tabular-nums ${t.up ? "text-[#00ff41]" : "text-[#ff3366]"}`}
                  >
                    {t.chg}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
