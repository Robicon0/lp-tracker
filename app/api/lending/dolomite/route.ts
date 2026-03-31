import { NextResponse } from 'next/server';

// DolomiteMargin on Arbitrum — verified on Arbiscan
const DOLOMITE_MARGIN = '0x6Bd780E7fDf01D77e4d475c821f1e7AE05409072';
const ALCHEMY_KEY = process.env.NEXT_PUBLIC_ALCHEMY_KEY;
const ARB_RPC = `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;

// ABI selectors (keccak256 computed with viem)
const SEL_GET_MARKETS       = '0x0f47fab0'; // getAccountMarketsWithBalances((address,uint256))
const SEL_GET_TOKEN         = '0x062bd3e9'; // getMarketTokenAddress(uint256)
const SEL_GET_WEI           = '0xc190c2ec'; // getAccountWei((address,uint256),uint256)
const SEL_GET_INTEREST_RATE = '0xfd47eda6'; // getMarketInterestRate(uint256) → Interest.Rate{value:uint256} per-second (1e18=100%/s)
const SEL_GET_TOTAL_PAR     = '0xcb04a34c'; // getMarketTotalPar(uint256) → TotalPar{borrow:uint128,supply:uint128}
const SEL_GET_EARNINGS_RATE = '0xe5520228'; // getEarningsRate() → Decimal.D256{value:uint256} (1e18=100%)

const SECONDS_PER_YEAR = 365 * 24 * 3600;

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

// ── On-chain APY for each Dolomite market ─────────────────────────────────────
// Uses getMarketInterestRate (per-second borrow rate) + getMarketTotalPar (utilization)
// + getEarningsRate (supplier's share) to compute supply APY.
let _earningsRateCache: { value: number; ts: number } | null = null;

async function getEarningsRate(): Promise<number> {
  const now = Date.now();
  if (_earningsRateCache && now - _earningsRateCache.ts < 300_000) return _earningsRateCache.value;
  try {
    const hex = await ethCall(SEL_GET_EARNINGS_RATE);
    const raw = BigInt('0x' + hex.replace('0x', '').padEnd(64, '0').slice(0, 64));
    const value = Number(raw) / 1e18;
    _earningsRateCache = { value, ts: now };
    console.log(`[dolomite/route] earningsRate=${value.toFixed(4)}`);
    return value;
  } catch (err) {
    console.error('[dolomite/route] getEarningsRate failed:', err);
    return 0.9; // fallback: 90% of borrow interest goes to suppliers
  }
}

async function getMarketSupplyApy(marketId: number, earningsRate: number): Promise<number | null> {
  try {
    const [rateHex, parHex] = await Promise.all([
      ethCall(SEL_GET_INTEREST_RATE + padU256(marketId)),
      ethCall(SEL_GET_TOTAL_PAR + padU256(marketId)),
    ]);

    // Decode borrow rate per second: Interest.Rate { value: uint256 } (1e18 = 100%/s)
    const rateRaw = BigInt('0x' + rateHex.replace('0x', '').padEnd(64, '0').slice(0, 64));
    const borrowRatePerSecond = Number(rateRaw) / 1e18;

    // Decode TotalPar { borrow: uint128, supply: uint128 } — two 32-byte words
    const parClean = parHex.replace('0x', '').padEnd(128, '0');
    const borrowPar = Number(BigInt('0x' + parClean.slice(0, 64)));
    const supplyPar = Number(BigInt('0x' + parClean.slice(64, 128)));
    const totalPar = borrowPar + supplyPar;
    if (totalPar === 0) return 0;

    const utilization = borrowPar / totalPar;
    const supplyRatePerYear = borrowRatePerSecond * utilization * earningsRate * SECONDS_PER_YEAR;
    const supplyApyPct = supplyRatePerYear * 100;
    return supplyApyPct;
  } catch (err) {
    console.error(`[dolomite/route] getMarketSupplyApy(${marketId}) failed:`, err);
    return null;
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

    // Step 4: Fetch prices + earnings rate in parallel; then supply APYs per market
    const symbols = Object.values(metaMap).map((m) => m.symbol);
    const [prices, earningsRate] = await Promise.all([fetchPrices(symbols), getEarningsRate()]);

    // Fetch supply APY for each unique market id in parallel
    const uniqueMarketIds = [...new Set(markets.map((m) => m.marketId))];
    const apyByMarketId: Record<number, number | null> = {};
    await Promise.allSettled(
      uniqueMarketIds.map(async (id) => {
        apyByMarketId[id] = await getMarketSupplyApy(id, earningsRate);
      }),
    );
    console.log('[dolomite/route] On-chain supply APYs:', JSON.stringify(
      Object.fromEntries(uniqueMarketIds.map((id) => [id, apyByMarketId[id]?.toFixed(4) ?? 'null']))
    ));

    // Step 5: Build supplies and borrows
    const supplies: Array<{ symbol: string; amount: number; usdValue: number; apy: number | null }> = [];
    const borrows: Array<{ symbol: string; amount: number; usdValue: number; apy: number | null }> = [];

    for (const m of markets) {
      const meta = metaMap[m.tokenAddr];
      if (!meta) continue;
      const amount = Number(m.rawVal) / Math.pow(10, meta.decimals);
      if (amount < 0.000001) continue;
      const price = prices[meta.symbol] ?? 0;
      const usdValue = amount * price;
      const apy = apyByMarketId[m.marketId] ?? null;
      console.log(`[dolomite/route] ${m.sign ? 'Supply' : 'Borrow'}: ${meta.symbol} amount=${amount.toFixed(4)} usd=${usdValue.toFixed(2)} apy=${apy?.toFixed(4) ?? 'null'}%`);
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
