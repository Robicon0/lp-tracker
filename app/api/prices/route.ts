import { NextRequest, NextResponse } from "next/server";
import { logPrice } from "../../lib/priceLogger";
import { getSpotPrices, setSpotPrices } from "../../lib/redisSpotCache";

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

// In-memory cache: key → { data, expiresAt, at }
const cache = new Map<string, { data: unknown; expiresAt: number; at: number }>();
const CACHE_TTL_MS = 60_000; // 60 seconds

// Stale-while-error for simple/price. When CoinGecko does not answer (429, 5xx,
// network), the answer is the LAST KNOWN price of each id: this instance's last
// answer first, then the shared spot store (`cg_spot_v1`, written on every
// successful answer by every instance). Each entry served that way carries
// `last_known_at` (ms) so the page can mark it; an id with no last known price
// is left out and the page shows "price unavailable" for it, never 0. With no
// last known price for any id the route answers 503.
type SimplePrice = Record<string, { usd?: number; usd_24h_change?: number; last_known_at?: number }>;

function markLastKnown(data: unknown, at: number): SimplePrice {
  const out: SimplePrice = {};
  for (const [id, v] of Object.entries((data ?? {}) as SimplePrice)) {
    if (v && typeof v.usd === "number" && v.usd > 0) out[id] = { usd: v.usd, last_known_at: v.last_known_at ?? at };
  }
  return out;
}

async function lastKnownSimplePrices(ids: string[], cached: { data: unknown; at: number } | undefined): Promise<SimplePrice | null> {
  const out: SimplePrice = cached ? markLastKnown(cached.data, cached.at) : {};
  const missing = ids.filter((id) => !out[id]);
  if (missing.length > 0) {
    const stored = await getSpotPrices(missing);
    for (const id of missing) {
      const e = stored[id];
      if (e && e.usd > 0) out[id] = { usd: e.usd, last_known_at: e.at };
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

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

    const simpleIds = endpoint === "simple/price"
      ? (searchParams.get("ids") || "").split(",").map((x) => x.trim()).filter(Boolean)
      : [];
    const lastKnownAnswer = async (why: string): Promise<NextResponse | null> => {
      if (endpoint !== "simple/price") return null;
      const lk = await lastKnownSimplePrices(simpleIds, cached);
      console.warn(`[api/prices] CoinGecko ${why}: serving last known prices for ${lk ? Object.keys(lk).length : 0} of ${simpleIds.length} ids`);
      if (!lk) return NextResponse.json({ error: `CoinGecko ${why}; no last known price`, unavailable: true }, { status: 503 });
      logSpotTokens(lk);
      return NextResponse.json(lk, { headers: { "x-price-basis": "last-known" } });
    };

    let response: Response;
    try {
      response = await fetch(url, { headers: { Accept: "application/json" } });
    } catch (err) {
      const lk = await lastKnownAnswer(`unreachable (${String(err).slice(0, 60)})`);
      if (lk) return lk;
      throw err;
    }

    if (!response.ok) {
      const lk = await lastKnownAnswer(`returned ${response.status}`);
      if (lk) return lk;
      // Other endpoints: on 429, return stale cache if available rather than an error
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
    cache.set(url, { data, expiresAt: Date.now() + CACHE_TTL_MS, at: Date.now() });
    if (endpoint === "simple/price" && process.env.CLOSED_POS_CACHE_READONLY !== "1") {
      const usd: Record<string, number> = {};
      for (const [id, v] of Object.entries((data ?? {}) as SimplePrice)) if (v && typeof v.usd === "number") usd[id] = v.usd;
      setSpotPrices(usd);
    }
    logSpotTokens(data);
    return NextResponse.json(data);
  } catch (err) {
    console.error("[api/prices] proxy error:", err);
    return NextResponse.json({ error: "Failed to fetch prices" }, { status: 500 });
  }
}
