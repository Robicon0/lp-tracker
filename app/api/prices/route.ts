import { NextRequest, NextResponse } from "next/server";

// Server-side proxy for CoinGecko API — avoids CORS errors from browser clients.
// All client-side code should call /api/prices?... instead of api.coingecko.com directly.

// In-memory cache: key → { data, expiresAt }
const cache = new Map<string, { data: unknown; expiresAt: number }>();
const CACHE_TTL_MS = 60_000; // 60 seconds

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const endpoint = searchParams.get("endpoint") || "simple/price";

  try {
    let url: string;

    if (endpoint === "simple/price") {
      const ids = searchParams.get("ids") || "";
      const vs = searchParams.get("vs_currencies") || "usd";
      url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=${vs}`;
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
      return NextResponse.json(cached.data);
    }

    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      // On 429, return stale cache if available rather than an error
      if (response.status === 429 && cached) {
        return NextResponse.json(cached.data);
      }
      return NextResponse.json(
        { error: `CoinGecko returned ${response.status}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    cache.set(url, { data, expiresAt: Date.now() + CACHE_TTL_MS });
    return NextResponse.json(data);
  } catch (err) {
    console.error("[api/prices] proxy error:", err);
    return NextResponse.json({ error: "Failed to fetch prices" }, { status: 500 });
  }
}
