import { NextResponse } from 'next/server';

// DolomiteMargin on Arbitrum — verified on Arbiscan
const DOLOMITE_MARGIN = '0x6Bd780E7fDf01D77e4d475c821f1e7AE05409072';
const ALCHEMY_KEY = process.env.NEXT_PUBLIC_ALCHEMY_KEY;
const ARB_RPC = `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;

// ABI selectors (keccak256 computed with viem)
const SEL_GET_MARKETS   = '0x0f47fab0'; // getAccountMarketsWithBalances((address,uint256))
const SEL_GET_TOKEN     = '0x062bd3e9'; // getMarketTokenAddress(uint256)
const SEL_GET_WEI       = '0xc190c2ec'; // getAccountWei((address,uint256),uint256)

function padAddr(addr: string) {
  return '000000000000000000000000' + addr.toLowerCase().replace('0x', '');
}
function padU256(n: number | bigint) {
  return BigInt(n).toString(16).padStart(64, '0');
}

async function ethCall(data: string): Promise<string> {
  const res = await fetch(ARB_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'eth_call',
      params: [{ to: DOLOMITE_MARGIN, data }, 'latest'],
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result ?? '0x';
}

// Decode uint256[] from ABI-encoded dynamic array response
function decodeUint256Array(hex: string): number[] {
  const raw = hex.replace('0x', '');
  if (raw.length < 128) return [];
  const len = parseInt(raw.slice(64, 128), 16);
  const result: number[] = [];
  for (let i = 0; i < len; i++) {
    result.push(parseInt(raw.slice(128 + i * 64, 128 + i * 64 + 64), 16));
  }
  return result;
}

// ── DefiLlama APY lookup for Dolomite markets ─────────────────────────────────
// Dolomite has no public REST API for rates — fetch from DefiLlama yields
let _defiLlamaCache: { data: Record<string, number>; ts: number } | null = null;
async function getDolomiteApys(): Promise<Record<string, number>> {
  const now = Date.now();
  if (_defiLlamaCache && now - _defiLlamaCache.ts < 300_000) return _defiLlamaCache.data;
  try {
    const res = await fetch('https://yields.llama.fi/pools', { next: { revalidate: 300 } }).then((r) => r.json());
    const pools: Array<{ project: string; chain: string; symbol: string; apyBase: number | null }> =
      Array.isArray(res?.data) ? res.data : [];
    const apys: Record<string, number> = {};
    for (const pool of pools) {
      if (pool.project?.toLowerCase().includes('dolomite') && pool.chain === 'Arbitrum' && pool.apyBase != null) {
        // symbol may be e.g. "USDC" or "WETH-USDC", take first token
        const sym = pool.symbol.split('-')[0].trim().toUpperCase();
        // Keep highest APY if multiple pools for same symbol
        if (!apys[sym] || pool.apyBase > apys[sym]) apys[sym] = pool.apyBase;
      }
    }
    _defiLlamaCache = { data: apys, ts: now };
    console.log(`[dolomite/route] DefiLlama APYs loaded: ${Object.keys(apys).join(', ')}`);
    return apys;
  } catch (err) {
    console.error('[dolomite/route] DefiLlama APY fetch failed:', err);
    return _defiLlamaCache?.data ?? {};
  }
}

// Static price map for common stables (always $1)
const STABLE_PRICE: Record<string, number> = {
  USDC: 1, USDT: 1, DAI: 1, 'USDC.e': 1, USDbC: 1,
};

// CoinGecko ID map for non-stables Dolomite supports
const CG_IDS: Record<string, string> = {
  WETH: 'ethereum', ETH: 'ethereum',
  WBTC: 'bitcoin',
  ARB:  'arbitrum',
  LINK: 'chainlink',
  UNI:  'uniswap',
  GMX:  'gmx',
  PENDLE: 'pendle',
  GRAIL: 'camelot-token',
  'PT-weETH': 'ethereum',
};

async function fetchPrices(symbols: string[]): Promise<Record<string, number>> {
  const prices: Record<string, number> = {};
  // Stables
  for (const s of symbols) {
    if (STABLE_PRICE[s] !== undefined) prices[s] = STABLE_PRICE[s];
  }
  // Non-stables via CoinGecko
  const needsPrice = symbols.filter((s) => prices[s] === undefined && CG_IDS[s]);
  if (needsPrice.length === 0) return prices;
  const ids = [...new Set(needsPrice.map((s) => CG_IDS[s]))].join(',');
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
    ).then((r) => r.json());
    for (const sym of needsPrice) {
      const id = CG_IDS[sym];
      if (id && res[id]?.usd) prices[sym] = res[id].usd;
    }
  } catch (err) {
    console.error('[dolomite/route] CoinGecko fetch failed:', err);
  }
  return prices;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = searchParams.get('account');

  if (!account) return NextResponse.json({ error: 'account required' }, { status: 400 });
  if (!ALCHEMY_KEY) return NextResponse.json({ supplies: [], borrows: [] });

  try {
    // Step 1: Get market IDs with non-zero balances
    const marketsHex = await ethCall(
      SEL_GET_MARKETS + padAddr(account) + padU256(0),
    );
    const marketIds = decodeUint256Array(marketsHex);

    if (marketIds.length === 0) {
      return NextResponse.json({ supplies: [], borrows: [], protocol: 'Dolomite', chain: 'Arbitrum' });
    }

    console.log(`[dolomite/route] ${account} has ${marketIds.length} markets:`, marketIds);

    // Step 2: For each market, fetch token address + Wei balance in parallel
    const marketData = await Promise.allSettled(
      marketIds.map(async (marketId) => {
        const [tokenHex, weiHex] = await Promise.all([
          ethCall(SEL_GET_TOKEN + padU256(marketId)),
          ethCall(SEL_GET_WEI + padAddr(account) + padU256(0) + padU256(marketId)),
        ]);

        // Decode token address (last 20 bytes of 32-byte word)
        const tokenAddr = '0x' + tokenHex.replace('0x', '').slice(24);

        // Decode Wei: word[0] = bool sign, word[1] = uint128 value
        const raw = weiHex.replace('0x', '');
        const sign = raw.length >= 64 ? parseInt(raw.slice(0, 64), 16) !== 0 : false;
        const rawVal = raw.length >= 128 ? BigInt('0x' + raw.slice(64, 128)) : 0n;

        return { marketId, tokenAddr: tokenAddr.toLowerCase(), sign, rawVal };
      }),
    );

    const markets = marketData
      .filter((r): r is PromiseFulfilledResult<{ marketId: number; tokenAddr: string; sign: boolean; rawVal: bigint }> => r.status === 'fulfilled')
      .map((r) => r.value)
      .filter((m) => m.rawVal > 0n);

    if (markets.length === 0) {
      return NextResponse.json({ supplies: [], borrows: [], protocol: 'Dolomite', chain: 'Arbitrum' });
    }

    // Step 3: Get token metadata via Alchemy for each unique token address
    const uniqueAddrs = [...new Set(markets.map((m) => m.tokenAddr))];
    const metaMap: Record<string, { symbol: string; decimals: number; name: string }> = {};

    await Promise.allSettled(
      uniqueAddrs.map(async (addr) => {
        try {
          const res = await fetch(ARB_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0', id: 1,
              method: 'alchemy_getTokenMetadata',
              params: [addr],
            }),
          }).then((r) => r.json());
          if (res.result?.symbol) {
            metaMap[addr] = {
              symbol: res.result.symbol,
              decimals: res.result.decimals ?? 18,
              name: res.result.name ?? res.result.symbol,
            };
          }
        } catch (err) {
          console.error(`[dolomite/route] metadata failed for ${addr}:`, err);
        }
      }),
    );

    // Step 4: Fetch prices + APYs in parallel
    const symbols = Object.values(metaMap).map((m) => m.symbol);
    const [prices, apys] = await Promise.all([fetchPrices(symbols), getDolomiteApys()]);

    // Step 5: Build supplies and borrows
    const supplies: Array<{ symbol: string; amount: number; usdValue: number; apy: number }> = [];
    const borrows: Array<{ symbol: string; amount: number; usdValue: number; apy: number }> = [];

    for (const m of markets) {
      const meta = metaMap[m.tokenAddr];
      if (!meta) continue;
      const amount = Number(m.rawVal) / Math.pow(10, meta.decimals);
      if (amount < 0.000001) continue;
      const price = prices[meta.symbol] ?? 0;
      const usdValue = amount * price;
      const symUpper = meta.symbol.toUpperCase();
      const apy = apys[symUpper] ?? apys[symUpper.replace('.E', '')] ?? 0;
      const asset = { symbol: meta.symbol, amount, usdValue, apy };
      if (m.sign) {
        supplies.push(asset);
      } else {
        borrows.push(asset);
      }
    }

    return NextResponse.json({
      supplies,
      borrows,
      protocol: 'Dolomite',
      chain: 'Arbitrum',
    });
  } catch (err) {
    console.error('[dolomite/route] fetch failed:', err);
    return NextResponse.json({ supplies: [], borrows: [], error: String(err) });
  }
}
