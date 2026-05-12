"use client";

const PROTOCOL_COUNT = 7;
const CHAIN_COUNT = 3;

// Canonical CoinGecko IDs for these tickers — kept here next to the symbols so
// any future "make the ticker live" pass can pass these straight to
// /api/prices?ids=... Note: WBTC and CBBTC use their own CG IDs here
// ('wrapped-bitcoin' / 'coinbase-wrapped-btc') so the ticker shows true
// per-wrapper prices. This deliberately differs from SYMBOL_TO_CG_ID in
// app/hooks/useWalletTokens.ts which aliases them to 'bitcoin' for wallet
// balance aggregation — see CLAUDE.md note on stripAavePrefix / priceOf.
export const TICKER_CG_IDS: Record<string, string> = {
  BTC: "bitcoin",
  WBTC: "wrapped-bitcoin",
  CBBTC: "coinbase-wrapped-btc",
  ETH: "ethereum",
  SOL: "solana",
  SUI: "sui",
  ARB: "arbitrum",
  AERO: "aerodrome-finance",
  UNI: "uniswap",
  TAO: "bittensor",
  ZCASH: "zcash",
  HYPE: "hyperliquid",
  BNB: "binancecoin",
};

const TICKERS: { sym: string; price: string; chg: string; up: boolean }[] = [
  { sym: "BTC",   price: "94,210.00", chg: "+1.08%", up: true  },
  { sym: "WBTC",  price: "94,180.00", chg: "+1.05%", up: true  },
  { sym: "CBBTC", price: "94,200.00", chg: "+1.07%", up: true  },
  { sym: "ETH",   price: "3,182.40",  chg: "+2.14%", up: true  },
  { sym: "SOL",   price: "182.50",    chg: "+4.71%", up: true  },
  { sym: "SUI",   price: "3.84",      chg: "-1.22%", up: false },
  { sym: "ARB",   price: "1.18",      chg: "-0.54%", up: false },
  { sym: "AERO",  price: "0.94",      chg: "+3.20%", up: true  },
  { sym: "UNI",   price: "11.42",     chg: "+0.88%", up: true  },
  { sym: "TAO",   price: "480.00",    chg: "-2.10%", up: false },
  { sym: "ZCASH", price: "42.50",     chg: "+5.80%", up: true  },
  { sym: "HYPE",  price: "28.40",     chg: "+6.40%", up: true  },
  { sym: "BNB",   price: "678.00",    chg: "+0.95%", up: true  },
];

export default function PriceTickerStrip() {
  const doubled = [...TICKERS, ...TICKERS];
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
            style={{ animation: "defidesh-ticker 25s linear infinite" }}
          >
            {doubled.map((t, i) => (
              <div key={i} className="text-[14px] flex gap-2 items-center">
                <span className="text-[#888]">{t.sym}</span>
                <span className="text-[#e8e8e8] tabular-nums">${t.price}</span>
                <span
                  className={`tabular-nums ${t.up ? "text-[#00ff41]" : "text-[#ff3366]"}`}
                >
                  {t.chg}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
