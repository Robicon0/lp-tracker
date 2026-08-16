import { type NextRequest } from "next/server";
import { resolveCoingeckoId } from "../../../lib/tokenIds";
import { isStableSymbol } from "../../../lib/calculations";

// GET /api/prices/historical?symbols=ETH,USDC&timestamp=1783192380
//
// USD price of each symbol at a specific past moment. Cascade, corrected
// against measurement rather than assumption (Invariant #2):
//
//   1. Stablecoins  -> $1.00, never fetched.
//   2. DeFiLlama    -> genuinely time-granular. Asking for 19:13 returns the
//                      19:13 price, batches every symbol into one request,
//                      and reaches years back.
//   3. CoinGecko    -> DATE-ONLY (one snapshot per day), capped at 365 days
//                      on the free tier, and rate-limits hard: 5 of 10
//                      sequential calls returned 429 in testing. Last resort
//                      only, and its answer is flagged `coarse` so the UI can
//                      say the price is midnight-of-that-day, not the exact
//                      minute.
//   4. Anything still missing -> `unresolved`, for manual entry.
//
// The caller supplies an absolute unix timestamp, so timezone conversion has
// already happened client-side where the device's offset is known.

type PriceSource = "stable" | "defillama" | "coingecko";

interface HistoricalPriceResponse {
  prices: Record<string, number>;
  sources: Record<string, PriceSource>;
  // Symbols whose price is a whole-day snapshot rather than the exact moment.
  coarse: string[];
  unresolved: string[];
  timestamp: number;
  error?: string;
}

async function fetchDefiLlama(
  idToSymbol: Map<string, string>,
  timestamp: number,
): Promise<Record<string, number>> {
  if (idToSymbol.size === 0) return {};
  const keys = [...idToSymbol.keys()].map((id) => `coingecko:${id}`);
  const url = `https://coins.llama.fi/prices/historical/${timestamp}/${encodeURIComponent(
    keys.join(","),
  )}`;
  const res = await fetch(url, {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`DeFiLlama ${res.status}`);
  const data = (await res.json()) as {
    coins?: Record<string, { price?: number }>;
  };
  const out: Record<string, number> = {};
  for (const [key, obj] of Object.entries(data.coins ?? {})) {
    const id = key.startsWith("coingecko:")
      ? key.slice("coingecko:".length)
      : key;
    const symbol = idToSymbol.get(id);
    if (symbol && obj && typeof obj.price === "number" && Number.isFinite(obj.price)) {
      out[symbol] = obj.price;
    }
  }
  return out;
}

// One call per symbol, hence the rate-limit risk — only reached for symbols
// DeFiLlama could not price.
async function fetchCoinGeckoDaily(
  id: string,
  timestamp: number,
): Promise<number | null> {
  const d = new Date(timestamp * 1000);
  const date = `${String(d.getUTCDate()).padStart(2, "0")}-${String(
    d.getUTCMonth() + 1,
  ).padStart(2, "0")}-${d.getUTCFullYear()}`;
  const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(
    id,
  )}/history?date=${date}&localization=false`;
  const res = await fetch(url, {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    market_data?: { current_price?: { usd?: number } };
  };
  const price = data.market_data?.current_price?.usd;
  return typeof price === "number" && Number.isFinite(price) ? price : null;
}

export async function GET(request: NextRequest): Promise<Response> {
  const params = request.nextUrl.searchParams;
  const rawSymbols = params.get("symbols") ?? "";
  const timestamp = Number(params.get("timestamp"));

  const symbols = [
    ...new Set(
      rawSymbols
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s !== ""),
    ),
  ];

  const prices: Record<string, number> = {};
  const sources: Record<string, PriceSource> = {};
  const coarse: string[] = [];
  const unresolved: string[] = [];

  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    const body: HistoricalPriceResponse = {
      prices,
      sources,
      coarse,
      unresolved: symbols,
      timestamp: 0,
      error: "A valid timestamp is required.",
    };
    return Response.json(body, { status: 400 });
  }

  // Stablecoins never hit the network.
  const idToSymbol = new Map<string, string>();
  for (const symbol of symbols) {
    if (isStableSymbol(symbol)) {
      prices[symbol] = 1;
      sources[symbol] = "stable";
      continue;
    }
    const id = resolveCoingeckoId(symbol);
    if (id) idToSymbol.set(id, symbol);
    else unresolved.push(symbol);
  }

  let error: string | undefined;

  try {
    const llama = await fetchDefiLlama(idToSymbol, timestamp);
    for (const [symbol, price] of Object.entries(llama)) {
      prices[symbol] = price;
      sources[symbol] = "defillama";
    }
  } catch (err) {
    error = err instanceof Error ? err.message : "DeFiLlama failed";
  }

  // Last resort, one symbol at a time, and only for what is still missing.
  for (const [id, symbol] of idToSymbol) {
    if (symbol in prices) continue;
    try {
      const price = await fetchCoinGeckoDaily(id, timestamp);
      if (price !== null) {
        prices[symbol] = price;
        sources[symbol] = "coingecko";
        coarse.push(symbol);
      }
    } catch {
      // Swallowed: the symbol simply lands in `unresolved` below and the UI
      // offers manual entry. A failed backup must not fail the whole request.
    }
  }

  for (const symbol of idToSymbol.values()) {
    if (!(symbol in prices) && !unresolved.includes(symbol)) {
      unresolved.push(symbol);
    }
  }

  const body: HistoricalPriceResponse = {
    prices,
    sources,
    coarse,
    unresolved,
    timestamp,
    ...(error ? { error } : {}),
  };
  return Response.json(body);
}
