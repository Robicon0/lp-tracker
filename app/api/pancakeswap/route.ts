import { NextResponse } from 'next/server';
import { fetchCachedCoinGeckoPrices } from '../../lib/priceCache';
import { fetchPricesByUnknownTokens } from '../../lib/cgSymbolResolve';

const ALCHEMY_KEY = process.env.NEXT_PUBLIC_ALCHEMY_KEY;
const RPC = `https://bnb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;

const POSITION_MANAGER = '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364';

const KNOWN_TOKENS: Record<string, { symbol: string; decimals: number; coingeckoId: string }> = {
  '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': { symbol: 'WBNB',  decimals: 18, coingeckoId: 'binancecoin' },
  '0x55d398326f99059ff775485246999027b3197955': { symbol: 'USDT',  decimals: 18, coingeckoId: 'tether' },
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': { symbol: 'USDC',  decimals: 18, coingeckoId: 'usd-coin' },
  '0xe9e7cea3dedca5984780bafc599bd69add087d56': { symbol: 'BUSD',  decimals: 18, coingeckoId: 'binance-usd' },
  '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82': { symbol: 'CAKE',  decimals: 18, coingeckoId: 'pancakeswap-token' },
  '0x2170ed0880ac9a755fd29b2688956bd959f933f8': { symbol: 'ETH',   decimals: 18, coingeckoId: 'ethereum' },
  '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c': { symbol: 'BTCB',  decimals: 18, coingeckoId: 'bitcoin' },
  '0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3': { symbol: 'DAI',   decimals: 18, coingeckoId: 'dai' },
};

const SELECTORS = {
  balanceOf:           '0x70a08231',
  tokenOfOwnerByIndex: '0x2f745c59',
  positions:           '0x99fd0e82',
  symbol:              '0x95d89b41',
  decimals:            '0x313ce567',
};

function padAddress(addr: string): string {
  return addr.toLowerCase().replace('0x', '').padStart(64, '0');
}

function padUint256(value: bigint): string {
  return value.toString(16).padStart(64, '0');
}

async function rpcCall(to: string, data: string): Promise<string> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'eth_call',
      params: [{ to, data }, 'latest'],
      id: 1,
    }),
  });
  const json = await res.json();
  return json.result || '0x';
}

async function getBalance(account: string): Promise<number> {
  const result = await rpcCall(POSITION_MANAGER, SELECTORS.balanceOf + padAddress(account));
  if (!result || result === '0x') return 0;
  return parseInt(result, 16);
}

async function getTokenId(account: string, index: number): Promise<bigint> {
  const data = SELECTORS.tokenOfOwnerByIndex + padAddress(account) + padUint256(BigInt(index));
  const result = await rpcCall(POSITION_MANAGER, data);
  if (!result || result === '0x') return 0n;
  return BigInt(result);
}

interface PositionData {
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
}

async function getPosition(tokenId: bigint): Promise<PositionData | null> {
  const data = SELECTORS.positions + padUint256(tokenId);
  const result = await rpcCall(POSITION_MANAGER, data);
  if (!result || result === '0x' || result.length < 770) return null;

  const hex = result.startsWith('0x') ? result.slice(2) : result;
  const readWord = (i: number) => hex.slice(i * 64, (i + 1) * 64);
  const toAddress = (word: string) => '0x' + word.slice(24).toLowerCase();
  // Correct int24 decode: read last 3 bytes, sign-extend if >= 0x800000
  const toInt24 = (word: string) => {
    const v = parseInt(word.slice(-6), 16);
    return v >= 0x800000 ? v - 0x1000000 : v;
  };

  // word 0: nonce, 1: operator, 2: token0, 3: token1, 4: fee
  // 5: tickLower, 6: tickUpper, 7: liquidity
  // 8: feeGrowthInside0LastX128, 9: feeGrowthInside1LastX128
  // 10: tokensOwed0, 11: tokensOwed1
  return {
    token0:      toAddress(readWord(2)),
    token1:      toAddress(readWord(3)),
    fee:         parseInt(readWord(4), 16),
    tickLower:   toInt24(readWord(5)),
    tickUpper:   toInt24(readWord(6)),
    liquidity:   BigInt('0x' + readWord(7)),
    tokensOwed0: BigInt('0x' + readWord(10)),
    tokensOwed1: BigInt('0x' + readWord(11)),
  };
}

async function fetchTokenInfo(tokenAddress: string): Promise<{ symbol: string; decimals: number }> {
  try {
    const symResult = await rpcCall(tokenAddress, SELECTORS.symbol);
    const decResult = await rpcCall(tokenAddress, SELECTORS.decimals);

    let symbol = 'UNKNOWN';
    if (symResult && symResult.length > 130) {
      const hex = symResult.startsWith('0x') ? symResult.slice(2) : symResult;
      const strLen = parseInt(hex.slice(64, 128), 16);
      const strHex = hex.slice(128, 128 + strLen * 2);
      symbol = '';
      for (let i = 0; i < strHex.length; i += 2) {
        const charCode = parseInt(strHex.slice(i, i + 2), 16);
        if (charCode > 0) symbol += String.fromCharCode(charCode);
      }
    }
    const decimals = decResult && decResult !== '0x' ? parseInt(decResult, 16) : 18;
    return { symbol, decimals };
  } catch {
    return { symbol: 'UNKNOWN', decimals: 18 };
  }
}

function estimateAmounts(
  liquidity: bigint,
  tickLower: number,
  tickUpper: number,
  decimals0: number,
  decimals1: number
): { amount0: number; amount1: number } {
  if (liquidity === 0n) return { amount0: 0, amount1: 0 };
  const sqrtLower = Math.sqrt(1.0001 ** tickLower);
  const sqrtUpper = Math.sqrt(1.0001 ** tickUpper);
  const sqrtCurrent = (sqrtLower + sqrtUpper) / 2;
  const liq = Number(liquidity);
  return {
    amount0: Math.max(0, liq * (1 / sqrtCurrent - 1 / sqrtUpper) / (10 ** decimals0)),
    amount1: Math.max(0, liq * (sqrtCurrent - sqrtLower) / (10 ** decimals1)),
  };
}

async function fetchPrices(coingeckoIds: string[]): Promise<Record<string, number>> {
  return fetchCachedCoinGeckoPrices(coingeckoIds);
}

async function fetchPancakeAPYs(): Promise<Record<string, number>> {
  try {
    const res = await fetch('https://yields.llama.fi/pools', { next: { revalidate: 300 } });
    const data = await res.json();
    const pools = data.data?.filter((p: { project: string }) => p.project === 'pancakeswap-v3') || [];

    const apysByKey: Record<string, number[]> = {};
    for (const pool of pools) {
      if (pool.chain !== 'BSC') continue;
      if (pool.underlyingTokens?.length >= 2) {
        const tokens = pool.underlyingTokens.map((t: string) => t.toLowerCase()).sort();
        const key = `BSC-${tokens.join('-')}`;
        if (!apysByKey[key]) apysByKey[key] = [];
        apysByKey[key].push(pool.apyBase || pool.apy || 0);
      }
    }

    const result: Record<string, number> = {};
    for (const [key, apys] of Object.entries(apysByKey)) {
      const sorted = apys.sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      result[key] = Math.round(
        (sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) * 100
      ) / 100;
    }
    return result;
  } catch {
    return {};
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = searchParams.get('account');

  if (!account) {
    return NextResponse.json({ error: 'Account address required' }, { status: 400 });
  }
  if (!ALCHEMY_KEY) {
    return NextResponse.json({ error: 'Alchemy API key not configured' }, { status: 500 });
  }

  try {
    const allCoingeckoIds = Object.values(KNOWN_TOKENS).map(t => t.coingeckoId);
    const [prices, apyData] = await Promise.all([fetchPrices(allCoingeckoIds), fetchPancakeAPYs()]);

    const balance = await getBalance(account);
    if (balance === 0) {
      return NextResponse.json({ positions: [], count: 0, account });
    }

    const count = Math.min(balance, 20);
    const tokenIds: bigint[] = [];
    for (let i = 0; i < count; i++) {
      const id = await getTokenId(account, i);
      if (id > 0n) tokenIds.push(id);
    }

    const positions: ReturnType<typeof Object.assign>[] = [];

    for (const tokenId of tokenIds) {
      try {
        const pos = await getPosition(tokenId);
        if (!pos) continue;

        let t0Info = KNOWN_TOKENS[pos.token0];
        let t1Info = KNOWN_TOKENS[pos.token1];

        if (!t0Info) {
          const fetched = await fetchTokenInfo(pos.token0);
          t0Info = { ...fetched, coingeckoId: '' };
        }
        if (!t1Info) {
          const fetched = await fetchTokenInfo(pos.token1);
          t1Info = { ...fetched, coingeckoId: '' };
        }

        const { amount0, amount1 } = estimateAmounts(
          pos.liquidity, pos.tickLower, pos.tickUpper, t0Info.decimals, t1Info.decimals
        );

        let price0 = t0Info.coingeckoId ? (prices[t0Info.coingeckoId] || 0) : 0;
        let price1 = t1Info.coingeckoId ? (prices[t1Info.coingeckoId] || 0) : 0;

        // LAST-RESORT CG symbol-search fallback for BSC long-tail tokens
        // not in KNOWN_TOKENS. Inline per-position (same pattern as
        // Uniswap V3); 24h cache in the helper dedupes across positions.
        const cgFallbackTokens: Array<{ key: string; symbol: string }> = [];
        if (price0 <= 0 && t0Info.symbol && t0Info.symbol !== 'UNKNOWN') {
          cgFallbackTokens.push({ key: pos.token0, symbol: t0Info.symbol });
        }
        if (price1 <= 0 && t1Info.symbol && t1Info.symbol !== 'UNKNOWN') {
          cgFallbackTokens.push({ key: pos.token1, symbol: t1Info.symbol });
        }
        if (cgFallbackTokens.length > 0) {
          const cgPrices = await fetchPricesByUnknownTokens(cgFallbackTokens);
          if (cgPrices[pos.token0] > 0) price0 = cgPrices[pos.token0];
          if (cgPrices[pos.token1] > 0) price1 = cgPrices[pos.token1];
        }

        const value  = amount0 * price0 + amount1 * price1;

        const fees0  = Number(pos.tokensOwed0) / (10 ** t0Info.decimals);
        const fees1  = Number(pos.tokensOwed1) / (10 ** t1Info.decimals);
        const feesUsd = fees0 * price0 + fees1 * price1;

        const apyKey = `BSC-${[pos.token0, pos.token1].sort().join('-')}`;
        const apy = apyData[apyKey] || 0;

        // RULE: Closed positions (liquidity = 0) must ALWAYS be returned and
        // never filtered out. Status is set to 'Closed' below. Applies to all
        // current and future protocol integrations on any chain.
        const status =
          pos.liquidity === 0n ? 'Closed'
          : amount0 > 0.0001 && amount1 > 0.0001 ? 'In Range'
          : 'Out of Range';

        positions.push({
          id: `cake3-bsc-${tokenId.toString()}`,
          pair: `${t0Info.symbol} / ${t1Info.symbol}`,
          protocol: 'PancakeSwap V3',
          chain: 'BNB Chain',
          value:   Math.round(value   * 100) / 100,
          apy,
          fees:    Math.round(feesUsd * 100) / 100,
          status,
          tokenId: tokenId.toString(),
          fee:     pos.fee / 10000,
          amount0: Math.round(amount0 * 1000000) / 1000000,
          amount1: Math.round(amount1 * 1000000) / 1000000,
          token0Symbol:   t0Info.symbol,
          token1Symbol:   t1Info.symbol,
          tickLower:      pos.tickLower,
          tickUpper:      pos.tickUpper,
          token0Decimals: t0Info.decimals,
          token1Decimals: t1Info.decimals,
          token0Address:  pos.token0,
          token1Address:  pos.token1,
          liquidity: pos.liquidity.toString(),
          price0,
          price1,
          walletAddress: account,
        });
      } catch (err) {
        console.error(`PancakeSwap: error processing token ${tokenId}:`, err);
      }
    }

    return NextResponse.json({ positions, count: positions.length, account });
  } catch (err) {
    console.error('PancakeSwap V3 API error:', err);
    return NextResponse.json({ error: 'Failed to fetch positions' }, { status: 500 });
  }
}
