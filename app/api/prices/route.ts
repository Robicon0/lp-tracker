import { NextRequest, NextResponse } from "next/server";
import { logPrice } from "../../lib/priceLogger";

// Server-side proxy for CoinGecko API — avoids CORS errors from browser clients.
// All client-side code should call /api/prices?... instead of api.coingecko.com directly.
//
// Canonical CoinGecko IDs for the PriceTickerStrip tokens (callers pass these
// via ?ids=...):
//   BTC   → bitcoin                ETH   → ethereum
//   WBTC  → wrapped-bitcoin        SOL   → solana
//   CBBTC → coinbase-wrapped-btc   SUI   → sui
//   ARB   → arbitrum               UNI   → uniswap
//   AERO  → aerodrome-finance      TAO   → bittensor
//   ZCASH → zcash                  HYPE  → hyperliquid
//   BNB   → binancecoin
//
// See also: app/components/PriceTickerStrip.tsx (TICKER_CG_IDS) and
// app/hooks/useWalletTokens.ts (SYMBOL_TO_CG_ID — note that WBTC/CBBTC are
// intentionally aliased to 'bitcoin' there for wallet-balance aggregation).

// In-memory cache: key → { data, expiresAt }
const cache = new Map<string, { data: unknown; expiresAt: number }>();
const CACHE_TTL_MS = 60_000; // 60 seconds

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const endpoint = searchParams.get("endpoint") || "simple/price";

  // [PRICE_LOG] instrumentation (additive only): for simple/price responses,
  // emit one cg-spot price_lookup per requested token id. No-op for any other
  // endpoint. Does not touch the proxy logic or the returned payload.
  const logSpotTokens = (data: unknown) => {
    if (endpoint !== "simple/price") return;
    const ids = (searchParams.get("ids") || "").split(",").map((s) => s.trim()).filter(Boolean);
    const obj = (data ?? {}) as Record<string, { usd?: number }>;
    for (const id of ids) {
      const price = obj[id]?.usd;
      const ok = typeof price === "number" && price > 0;
      logPrice({
        event: "price_lookup",
        caller: "/api/prices",
        token: id,
        targetTimestamp: "now",
        attempts: [{ source: "cg-spot", token: id, result: ok ? (price as number) : null, reason: ok ? undefined : "no_price_in_response" }],
        finalPrice: ok ? (price as number) : null,
        finalSource: ok ? "cg-spot" : null,
        status: ok ? "ok" : "failed",
      });
    }
  };

  try {
    let url: string;

    if (endpoint === "simple/price") {
      const ids = searchParams.get("ids") || "";
      const vs = searchParams.get("vs_currencies") || "usd";
      const include24h = searchParams.get("include_24hr_change") === "true";
      url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=${vs}${include24h ? "&include_24hr_change=true" : ""}`;
    } else if (endpoint === "coins/markets") {
      const ids = searchParams.get("ids") || "";
      const vs = searchParams.get("vs_currencies") || "usd";
      const order = searchParams.get("order") || "market_cap_desc";
      const per_page = searchParams.get("per_page") || "100";
      const page = searchParams.get("page") || "1";
      url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=${vs}&ids=${ids}&order=${order}&per_page=${per_page}&page=${page}&sparkline=false`;
    } else {
      // Generic passthrough for any other endpoint
      const params = new URLSearchParams(searchParams);
      params.delete("endpoint");
      url = `https://api.coingecko.com/api/v3/${endpoint}?${params.toString()}`;
    }

    // Return cached response if still fresh
    const cached = cache.get(url);
    if (cached && Date.now() < cached.expiresAt) {
      logSpotTokens(cached.data);
      return NextResponse.json(cached.data);
    }

    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      // On 429, return stale cache if available rather than an error
      if (response.status === 429 && cached) {
        logSpotTokens(cached.data);
        return NextResponse.json(cached.data);
      }
      return NextResponse.json(
        { error: `CoinGecko returned ${response.status}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    cache.set(url, { data, expiresAt: Date.now() + CACHE_TTL_MS });
    logSpotTokens(data);
    return NextResponse.json(data);
  } catch (err) {
    console.error("[api/prices] proxy error:", err);
    return NextResponse.json({ error: "Failed to fetch prices" }, { status: 500 });
  }
}
