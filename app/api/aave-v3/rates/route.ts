import { NextResponse } from "next/server";

// Live AAVE V3 rates endpoint.
// Query:  GET /api/aave-v3/rates?chain=Arbitrum&tokens=0xaToken1,0xdebt1,...
// Tokens may be aTokens, variableDebtTokens, or stableDebtTokens — each of these
// contracts exposes UNDERLYING_ASSET_ADDRESS(). We derive the underlying and
// then read ProtocolDataProvider.getReserveData(underlying) which returns the
// live liquidityRate (supply APR) and variableBorrowRate (borrow APR) in RAY.
//
// Returns { rates: { [lowercase token contract addr]: { supplyApy, borrowApy } } }
// — keyed by the *input* token address so the client can look up directly.

const AAVE_V3_CHAINS: Record<string, { rpc: string; poolAddressesProvider: string; cgPlatform: string }> = {
  Ethereum: {
    rpc: `https://eth-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_KEY ?? ""}`,
    poolAddressesProvider: "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e",
    cgPlatform: "ethereum",
  },
  Arbitrum: {
    rpc: `https://arb-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_KEY ?? ""}`,
    poolAddressesProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
    cgPlatform: "arbitrum-one",
  },
  Optimism: {
    rpc: `https://opt-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_KEY ?? ""}`,
    poolAddressesProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
    cgPlatform: "optimistic-ethereum",
  },
  Polygon: {
    rpc: `https://polygon-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_KEY ?? ""}`,
    poolAddressesProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
    cgPlatform: "polygon-pos",
  },
  Base: {
    rpc: `https://base-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_KEY ?? ""}`,
    poolAddressesProvider: "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D",
    cgPlatform: "base",
  },
};

// Selectors
const SEL_GET_POOL_DATA_PROVIDER = "0xe860accb"; // IPoolAddressesProvider.getPoolDataProvider()
const SEL_UNDERLYING_ASSET       = "0xb16a19de"; // aToken/debtToken.UNDERLYING_ASSET_ADDRESS()
const SEL_GET_RESERVE_DATA       = "0x35ea6a75"; // ProtocolDataProvider.getReserveData(address)

const RAY = 1e27;

function padAddr(addr: string): string {
  return "000000000000000000000000" + addr.toLowerCase().replace(/^0x/, "");
}

function word(hex: string, idx: number): bigint {
  const raw = hex.replace(/^0x/, "");
  const slice = raw.slice(idx * 64, idx * 64 + 64);
  if (!slice || slice.length < 64) return 0n;
  return BigInt("0x" + slice);
}

function addrFromWord(hex: string, idx: number): string {
  const raw = hex.replace(/^0x/, "");
  const slice = raw.slice(idx * 64, idx * 64 + 64);
  return "0x" + slice.slice(-40);
}

// In-memory cache for PoolDataProvider lookups (per chain, 1 hour TTL)
const pdpCache: Record<string, { addr: string; ts: number }> = {};
// In-memory cache for token → underlying address (keyed by chain + contract, 1 hour TTL)
const underlyingCache: Record<string, { underlying: string; ts: number }> = {};
// In-memory cache for reserve rates (keyed by chain + underlying, 60s TTL so APYs stay fresh)
const rateCache: Record<string, { supplyApy: number; borrowApy: number; ts: number }> = {};
// In-memory cache for underlying USD prices via CoinGecko contract lookup (5 min TTL)
const priceCache: Record<string, { usd: number; ts: number }> = {};

const HOUR_MS = 60 * 60 * 1000;
const RATE_TTL_MS = 60 * 1000;
const PRICE_TTL_MS = 5 * 60 * 1000;

async function fetchUnderlyingPrices(
  cgPlatform: string,
  underlyings: string[],
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const fresh: string[] = [];
  for (const u of underlyings) {
    const key = `${cgPlatform}:${u.toLowerCase()}`;
    const c = priceCache[key];
    if (c && Date.now() - c.ts < PRICE_TTL_MS) out[u.toLowerCase()] = c.usd;
    else fresh.push(u);
  }
  if (fresh.length === 0) return out;
  try {
    const url = `https://api.coingecko.com/api/v3/simple/token_price/${cgPlatform}?contract_addresses=${fresh.join(",")}&vs_currencies=usd`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      console.error(`[aave-v3/rates] CoinGecko token_price ${cgPlatform} returned ${res.status}`);
      return out;
    }
    const json = (await res.json()) as Record<string, { usd?: number }>;
    for (const u of fresh) {
      const usd = json[u.toLowerCase()]?.usd ?? 0;
      out[u.toLowerCase()] = usd;
      priceCache[`${cgPlatform}:${u.toLowerCase()}`] = { usd, ts: Date.now() };
    }
  } catch (err) {
    console.error(`[aave-v3/rates] CoinGecko token_price fetch failed for ${cgPlatform}:`, err);
  }
  return out;
}

async function ethCall(rpc: string, to: string, data: string): Promise<string> {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    }),
  });
  const json = await res.json() as { result?: string; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  return json.result ?? "0x";
}

async function getPoolDataProvider(chain: string): Promise<string | null> {
  const cached = pdpCache[chain];
  if (cached && Date.now() - cached.ts < HOUR_MS) return cached.addr;
  const conf = AAVE_V3_CHAINS[chain];
  if (!conf) return null;
  try {
    const hex = await ethCall(conf.rpc, conf.poolAddressesProvider, SEL_GET_POOL_DATA_PROVIDER);
    const addr = addrFromWord(hex, 0);
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr) || addr === "0x" + "0".repeat(40)) return null;
    pdpCache[chain] = { addr, ts: Date.now() };
    return addr;
  } catch (err) {
    console.error(`[aave-v3/rates] PoolDataProvider lookup failed for ${chain}:`, err);
    return null;
  }
}

async function getUnderlyingAsset(chain: string, tokenAddr: string): Promise<string | null> {
  const key = `${chain}:${tokenAddr.toLowerCase()}`;
  const cached = underlyingCache[key];
  if (cached && Date.now() - cached.ts < HOUR_MS) return cached.underlying;
  const conf = AAVE_V3_CHAINS[chain];
  if (!conf) return null;
  try {
    const hex = await ethCall(conf.rpc, tokenAddr, SEL_UNDERLYING_ASSET);
    const underlying = addrFromWord(hex, 0);
    if (!/^0x[0-9a-fA-F]{40}$/.test(underlying) || underlying === "0x" + "0".repeat(40)) return null;
    underlyingCache[key] = { underlying, ts: Date.now() };
    return underlying;
  } catch (err) {
    console.error(`[aave-v3/rates] UNDERLYING_ASSET_ADDRESS failed for ${tokenAddr} on ${chain}:`, err);
    return null;
  }
}

async function getRates(
  chain: string,
  pdp: string,
  underlying: string,
): Promise<{ supplyApy: number; borrowApy: number } | null> {
  const key = `${chain}:${underlying.toLowerCase()}`;
  const cached = rateCache[key];
  if (cached && Date.now() - cached.ts < RATE_TTL_MS) {
    return { supplyApy: cached.supplyApy, borrowApy: cached.borrowApy };
  }
  const conf = AAVE_V3_CHAINS[chain];
  if (!conf) return null;
  try {
    const hex = await ethCall(conf.rpc, pdp, SEL_GET_RESERVE_DATA + padAddr(underlying));
    // ProtocolDataProvider.getReserveData returns a tuple of 12 uints:
    //   [0]unbackedMintCap [1]accruedToTreasury [2]totalAToken [3]totalStableDebt
    //   [4]totalVariableDebt [5]liquidityRate [6]variableBorrowRate [7]stableBorrowRate
    //   [8]averageStableBorrowRate [9]liquidityIndex [10]variableBorrowIndex [11]lastUpdateTimestamp
    const liquidityRate     = word(hex, 5); // supply APR in RAY
    const variableBorrowRate = word(hex, 6); // variable borrow APR in RAY
    const supplyApy = Number(liquidityRate) / RAY * 100;
    const borrowApy = Number(variableBorrowRate) / RAY * 100;
    rateCache[key] = { supplyApy, borrowApy, ts: Date.now() };
    return { supplyApy, borrowApy };
  } catch (err) {
    console.error(`[aave-v3/rates] getReserveData failed for ${underlying} on ${chain}:`, err);
    return null;
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const chain = searchParams.get("chain");
  const tokensParam = searchParams.get("tokens");
  if (!chain || !tokensParam) {
    return NextResponse.json({ error: "chain and tokens required" }, { status: 400 });
  }
  if (!AAVE_V3_CHAINS[chain]) {
    return NextResponse.json({ error: `unsupported chain: ${chain}` }, { status: 400 });
  }

  const tokens = tokensParam
    .split(",")
    .map((t) => t.trim())
    .filter((t) => /^0x[0-9a-fA-F]{40}$/.test(t))
    .slice(0, 40); // cap — avoid abuse

  if (tokens.length === 0) return NextResponse.json({ rates: {} });

  const pdp = await getPoolDataProvider(chain);
  if (!pdp) {
    console.error(`[aave-v3/rates] No PoolDataProvider resolved for ${chain} — returning empty`);
    return NextResponse.json({ rates: {}, chain, error: "pool_data_provider_unresolved" });
  }

  const rates: Record<string, { supplyApy: number; borrowApy: number }> = {};
  const tokenToUnderlying: Record<string, string> = {};
  await Promise.allSettled(
    tokens.map(async (tokenAddr) => {
      const underlying = await getUnderlyingAsset(chain, tokenAddr);
      if (!underlying) return;
      tokenToUnderlying[tokenAddr.toLowerCase()] = underlying.toLowerCase();
      const r = await getRates(chain, pdp, underlying);
      if (!r) return;
      rates[tokenAddr.toLowerCase()] = r;
    }),
  );

  // Batch CoinGecko contract-address price lookup for every underlying we
  // resolved — guarantees correct USD pricing for any AAVE reserve, even
  // ones whose symbol we don't know ahead of time.
  const chainConf = AAVE_V3_CHAINS[chain];
  const uniqueUnderlyings = Array.from(new Set(Object.values(tokenToUnderlying)));
  const underlyingPrices = uniqueUnderlyings.length > 0
    ? await fetchUnderlyingPrices(chainConf.cgPlatform, uniqueUnderlyings)
    : {};

  const prices: Record<string, number> = {};
  for (const [tok, und] of Object.entries(tokenToUnderlying)) {
    const p = underlyingPrices[und];
    if (typeof p === "number" && p > 0) prices[tok] = p;
  }

  return NextResponse.json({ rates, prices, chain });
}
