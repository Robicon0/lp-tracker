import { type NextRequest } from "next/server";
import { resolveCoingeckoId } from "../../lib/tokenIds";

// GET /api/prices?symbols=SOL,ETH,ZEC
// Returns current USD prices for the requested token symbols. Symbols are
// mapped to CoinGecko IDs via the curated map; CoinGecko is primary and
// DeFiLlama is the backup for IDs CoinGecko doesn't return. Symbols with no
// curated mapping (or no price from either source) come back in `unresolved`
// so the page can fall back to manual entry. Keeps API access server-side.

interface PriceResponse {
  prices: Record<string, number>;
  unresolved: string[];
  updatedAt: string;
  sources: string[];
  error?: string;
}

async function fetchCoinGecko(
  ids: string[],
): Promise<Record<string, number>> {
  if (ids.length === 0) return {};
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(
    ids.join(","),
  )}&vs_currencies=usd`;
  const res = await fetch(url, {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  const data = (await res.json()) as Record<string, { usd?: number }>;
  const out: Record<string, number> = {};
  for (const [id, obj] of Object.entries(data)) {
    if (obj && typeof obj.usd === "number" && Number.isFinite(obj.usd)) {
      out[id] = obj.usd;
    }
  }
  return out;
}

async function fetchDefiLlama(
  ids: string[],
): Promise<Record<string, number>> {
  if (ids.length === 0) return {};
  const keys = ids.map((id) => `coingecko:${id}`);
  const url = `https://coins.llama.fi/prices/current/${encodeURIComponent(
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
    const id = key.startsWith("coingecko:") ? key.slice("coingecko:".length) : key;
    if (obj && typeof obj.price === "number" && Number.isFinite(obj.price)) {
      out[id] = obj.price;
    }
  }
  return out;
}

export async function GET(request: NextRequest): Promise<Response> {
  const raw = request.nextUrl.searchParams.get("symbols") ?? "";
  const symbols = [
    ...new Set(
      raw
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s !== ""),
    ),
  ];

  // Map symbols → CoinGecko IDs; track which symbols have no curated mapping.
  const idToSymbol = new Map<string, string>();
  const unresolved: string[] = [];
  for (const symbol of symbols) {
    const id = resolveCoingeckoId(symbol);
    if (id) idToSymbol.set(id, symbol);
    else unresolved.push(symbol);
  }
  const ids = [...idToSymbol.keys()];

  const prices: Record<string, number> = {};
  const sources: string[] = [];
  let error: string | undefined;

  // Primary: CoinGecko. Backup: DeFiLlama for whatever CoinGecko missed.
  let cgPrices: Record<string, number> = {};
  try {
    cgPrices = await fetchCoinGecko(ids);
    if (Object.keys(cgPrices).length > 0) sources.push("coingecko");
  } catch (err) {
    error = err instanceof Error ? err.message : "CoinGecko failed";
  }
  for (const [id, price] of Object.entries(cgPrices)) {
    const symbol = idToSymbol.get(id);
    if (symbol) prices[symbol] = price;
  }

  const missing = ids.filter((id) => !(idToSymbol.get(id)! in prices));
  if (missing.length > 0) {
    try {
      const llamaPrices = await fetchDefiLlama(missing);
      if (Object.keys(llamaPrices).length > 0) sources.push("defillama");
      for (const [id, price] of Object.entries(llamaPrices)) {
        const symbol = idToSymbol.get(id);
        if (symbol) prices[symbol] = price;
      }
    } catch (err) {
      if (!error) {
        error = err instanceof Error ? err.message : "DeFiLlama failed";
      }
    }
  }

  // Any mapped symbol still without a price joins the manual-fallback list.
  for (const symbol of idToSymbol.values()) {
    if (!(symbol in prices) && !unresolved.includes(symbol)) {
      unresolved.push(symbol);
    }
  }

  const body: PriceResponse = {
    prices,
    unresolved,
    updatedAt: new Date().toISOString(),
    sources,
    ...(error ? { error } : {}),
  };
  return Response.json(body);
}
