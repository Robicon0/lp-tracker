import { NextResponse } from 'next/server';

const HYPEREVM_RPC = 'https://rpc.hyperliquid.xyz/evm';

// HyperSwap V3 NonfungiblePositionManager on HyperEVM
const HYPERSWAP_NFT_MANAGER = '0x6eda206207c09e5428f281761ddc0d300851fbc8';
// KittenSwap NonfungiblePositionManager on HyperEVM
const KITTENSWAP_NFT_MANAGER = '0xb9201e89f94a01ff13ad4caecf43a2e232513754';

const POSITION_MANAGERS = [
  { address: HYPERSWAP_NFT_MANAGER, protocol: 'HyperSwap' },
  { address: KITTENSWAP_NFT_MANAGER, protocol: 'KittenSwap' },
];

// Known tokens on HyperEVM
const KNOWN_TOKENS: Record<string, { symbol: string; decimals: number; coingeckoId: string }> = {
  '0xadcb2f358eae6492f61a5f87eb8893d09391d160': { symbol: 'WHYPE', decimals: 18, coingeckoId: 'hyperliquid' },
  '0xb88339cb7199b77e23db6e890353e22632ba630f': { symbol: 'USDC', decimals: 6, coingeckoId: 'usd-coin' },
  '0x24ac48bf01fd6cb1c3836d08b3edc70a9c4380ca': { symbol: 'USDC', decimals: 6, coingeckoId: 'usd-coin' },
};

// Function selectors (ERC-721 + Uniswap V3 NonfungiblePositionManager interface)
const SELECTORS = {
  balanceOf: '0x70a08231',          // balanceOf(address)
  tokenOfOwnerByIndex: '0x2f745c59', // tokenOfOwnerByIndex(address,uint256)
  positions: '0x99fd0e82',           // positions(uint256)
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
};

function padAddress(addr: string): string {
  return addr.toLowerCase().replace('0x', '').padStart(64, '0');
}

function padUint256(value: bigint): string {
  return value.toString(16).padStart(64, '0');
}

async function rpcCall(to: string, data: string): Promise<string> {
  const res = await fetch(HYPEREVM_RPC, {
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

async function getBalance(nftManager: string, account: string): Promise<number> {
  const data = SELECTORS.balanceOf + padAddress(account);
  const result = await rpcCall(nftManager, data);
  if (!result || result === '0x') return 0;
  return parseInt(result, 16);
}

async function getTokenId(nftManager: string, account: string, index: number): Promise<bigint> {
  const data = SELECTORS.tokenOfOwnerByIndex + padAddress(account) + padUint256(BigInt(index));
  const result = await rpcCall(nftManager, data);
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

async function getPosition(nftManager: string, tokenId: bigint): Promise<PositionData | null> {
  const data = SELECTORS.positions + padUint256(tokenId);
  const result = await rpcCall(nftManager, data);

  if (!result || result === '0x' || result.length < 770) return null;

  const hex = result.startsWith('0x') ? result.slice(2) : result;
  const readWord = (i: number) => hex.slice(i * 64, (i + 1) * 64);
  const toAddress = (word: string) => '0x' + word.slice(24).toLowerCase();
  const toInt24 = (word: string) => {
    const val = BigInt('0x' + word);
    const MAX = BigInt('0x7fffff');
    if (val > MAX) return Number(val - BigInt('0x1000000'));
    return Number(val);
  };

  // word 0: nonce, 1: operator, 2: token0, 3: token1, 4: fee,
  // 5: tickLower, 6: tickUpper, 7: liquidity, 8-9: feeGrowth, 10-11: tokensOwed
  const token0 = toAddress(readWord(2));
  const token1 = toAddress(readWord(3));
  const fee = parseInt(readWord(4), 16);
  const tickLower = toInt24(readWord(5));
  const tickUpper = toInt24(readWord(6));
  const liquidity = BigInt('0x' + readWord(7));
  const tokensOwed0 = BigInt('0x' + readWord(10));
  const tokensOwed1 = BigInt('0x' + readWord(11));

  return { token0, token1, fee, tickLower, tickUpper, liquidity, tokensOwed0, tokensOwed1 };
}

async function fetchTokenInfo(tokenAddress: string): Promise<{ symbol: string; decimals: number }> {
  const known = KNOWN_TOKENS[tokenAddress.toLowerCase()];
  if (known) return { symbol: known.symbol, decimals: known.decimals };

  try {
    const [symResult, decResult] = await Promise.all([
      rpcCall(tokenAddress, SELECTORS.symbol),
      rpcCall(tokenAddress, SELECTORS.decimals),
    ]);

    let symbol = tokenAddress.slice(0, 8);
    if (symResult && symResult.length > 130) {
      const hex = symResult.startsWith('0x') ? symResult.slice(2) : symResult;
      const strLen = parseInt(hex.slice(64, 128), 16);
      const strHex = hex.slice(128, 128 + strLen * 2);
      let s = '';
      for (let i = 0; i < strHex.length; i += 2) {
        const c = parseInt(strHex.slice(i, i + 2), 16);
        if (c > 0) s += String.fromCharCode(c);
      }
      if (s) symbol = s;
    } else if (symResult && symResult !== '0x' && symResult.length === 66) {
      // bytes32 encoded symbol (short string without length prefix)
      const hex = symResult.startsWith('0x') ? symResult.slice(2) : symResult;
      let s = '';
      for (let i = 0; i < 64; i += 2) {
        const c = parseInt(hex.slice(i, i + 2), 16);
        if (c > 0) s += String.fromCharCode(c);
        else break;
      }
      if (s) symbol = s;
    }

    const decimals = decResult && decResult !== '0x' ? parseInt(decResult, 16) : 18;
    return { symbol, decimals };
  } catch {
    return { symbol: tokenAddress.slice(2, 8).toUpperCase(), decimals: 18 };
  }
}

function calculateAmounts(
  liquidity: bigint,
  tickLower: number,
  tickUpper: number,
  decimals0: number,
  decimals1: number,
): { amount0: number; amount1: number } {
  if (liquidity === 0n) return { amount0: 0, amount1: 0 };

  const sqrtLower = Math.sqrt(1.0001 ** tickLower);
  const sqrtUpper = Math.sqrt(1.0001 ** tickUpper);
  const sqrtCurrent = (sqrtLower + sqrtUpper) / 2; // midpoint estimate

  const liq = Number(liquidity);
  const amount0 = Math.max(0, liq * (1 / sqrtCurrent - 1 / sqrtUpper)) / 10 ** decimals0;
  const amount1 = Math.max(0, liq * (sqrtCurrent - sqrtLower)) / 10 ** decimals1;

  return { amount0, amount1 };
}

async function fetchPrices(coingeckoIds: string[]): Promise<Record<string, number>> {
  const unique = [...new Set(coingeckoIds.filter(Boolean))];
  if (unique.length === 0) return {};
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${unique.join(',')}&vs_currencies=usd`,
      { next: { revalidate: 60 } },
    );
    const data = await res.json();
    const prices: Record<string, number> = {};
    for (const [id, val] of Object.entries(data)) {
      prices[id] = (val as { usd: number })?.usd || 0;
    }
    return prices;
  } catch {
    return {};
  }
}

async function fetchHyperSwapAPYs(): Promise<Record<string, number>> {
  try {
    const res = await fetch('https://yields.llama.fi/pools', { next: { revalidate: 300 } });
    const data = await res.json();
    const pools = (data.data || []).filter(
      (p: { project: string; chain: string }) =>
        (p.project === 'hyperswap-v3' || p.project === 'kittenswap') && p.chain === 'HyperEVM',
    );

    const apysByKey: Record<string, number[]> = {};
    for (const pool of pools) {
      if (pool.underlyingTokens?.length >= 2) {
        const key = pool.underlyingTokens.map((t: string) => t.toLowerCase()).sort().join('-');
        if (!apysByKey[key]) apysByKey[key] = [];
        apysByKey[key].push(pool.apyBase || pool.apy || 0);
      }
    }

    const result: Record<string, number> = {};
    for (const [key, apys] of Object.entries(apysByKey)) {
      const sorted = apys.sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      result[key] = Math.round((sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) * 100) / 100;
    }
    return result;
  } catch {
    return {};
  }
}

async function fetchPositionsForManager(
  nftManager: string,
  protocol: string,
  account: string,
): Promise<Array<{
  tokenId: bigint;
  pos: PositionData;
  protocol: string;
}>> {
  try {
    const balance = await getBalance(nftManager, account);
    if (balance === 0) return [];

    const count = Math.min(balance, 50);
    const tokenIds: bigint[] = [];
    for (let i = 0; i < count; i++) {
      const id = await getTokenId(nftManager, account, i);
      if (id > 0n) tokenIds.push(id);
    }

    const results: Array<{ tokenId: bigint; pos: PositionData; protocol: string }> = [];
    await Promise.all(
      tokenIds.map(async (tokenId) => {
        const pos = await getPosition(nftManager, tokenId);
        if (pos) results.push({ tokenId, pos, protocol });
      }),
    );
    return results;
  } catch {
    return [];
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = searchParams.get('account');

  if (!account) {
    return NextResponse.json({ error: 'Account address required' }, { status: 400 });
  }

  try {
    // Fetch from all position managers in parallel
    const allRaw = (await Promise.all(
      POSITION_MANAGERS.map(({ address, protocol }) => fetchPositionsForManager(address, protocol, account)),
    )).flat();

    if (allRaw.length === 0) {
      return NextResponse.json({ positions: [], count: 0, account });
    }

    // Collect all unique token addresses for metadata + prices
    const allTokenAddrs = [...new Set(allRaw.flatMap(({ pos }) => [pos.token0, pos.token1]))];
    const tokenInfoMap: Record<string, { symbol: string; decimals: number; coingeckoId: string }> = {};
    await Promise.all(
      allTokenAddrs.map(async (addr) => {
        const known = KNOWN_TOKENS[addr.toLowerCase()];
        if (known) {
          tokenInfoMap[addr] = known;
        } else {
          const info = await fetchTokenInfo(addr);
          tokenInfoMap[addr] = { ...info, coingeckoId: '' };
        }
      }),
    );

    const coingeckoIds = Object.values(tokenInfoMap).map((t) => t.coingeckoId).filter(Boolean);
    const [prices, apyData] = await Promise.all([
      fetchPrices(coingeckoIds),
      fetchHyperSwapAPYs(),
    ]);

    const positions = allRaw.map(({ tokenId, pos, protocol }) => {
      const t0Info = tokenInfoMap[pos.token0] || { symbol: pos.token0.slice(2, 8), decimals: 18, coingeckoId: '' };
      const t1Info = tokenInfoMap[pos.token1] || { symbol: pos.token1.slice(2, 8), decimals: 18, coingeckoId: '' };

      const { amount0, amount1 } = calculateAmounts(pos.liquidity, pos.tickLower, pos.tickUpper, t0Info.decimals, t1Info.decimals);

      const price0 = t0Info.coingeckoId ? (prices[t0Info.coingeckoId] || 0) : 0;
      const price1 = t1Info.coingeckoId ? (prices[t1Info.coingeckoId] || 0) : 0;
      const value = amount0 * price0 + amount1 * price1;

      const fees0 = Number(pos.tokensOwed0) / 10 ** t0Info.decimals;
      const fees1 = Number(pos.tokensOwed1) / 10 ** t1Info.decimals;
      const feesUsd = fees0 * price0 + fees1 * price1;

      const apyKey = [pos.token0, pos.token1].map((t) => t.toLowerCase()).sort().join('-');
      const apy = apyData[apyKey] || 0;

      // Determine range status: in range when both tokens are present; fallback on liquidity
      const hasToken0 = amount0 > 1e-9;
      const hasToken1 = amount1 > 1e-9;
      const status = pos.liquidity === 0n
        ? 'Closed'
        : (hasToken0 && hasToken1 ? 'In Range' : 'Out of Range');

      return {
        id: `hyperswap-${protocol.toLowerCase()}-${tokenId.toString()}`,
        pair: `${t0Info.symbol} / ${t1Info.symbol}`,
        protocol,
        chain: 'HyperEVM',
        value: Math.round(value * 100) / 100,
        apy,
        fees: Math.round(feesUsd * 100) / 100,
        status: status as 'In Range' | 'Out of Range' | 'Closed',
        tokenId: tokenId.toString(),
        fee: pos.fee / 10000,
        amount0: Math.round(amount0 * 1_000_000) / 1_000_000,
        amount1: Math.round(amount1 * 1_000_000) / 1_000_000,
        token0Symbol: t0Info.symbol,
        token1Symbol: t1Info.symbol,
        fees0: Math.round(fees0 * 1_000_000) / 1_000_000,
        fees1: Math.round(fees1 * 1_000_000) / 1_000_000,
        tickLower: pos.tickLower,
        tickUpper: pos.tickUpper,
        token0Decimals: t0Info.decimals,
        token1Decimals: t1Info.decimals,
      };
    });

    return NextResponse.json({ positions, count: positions.length, account });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch HyperSwap positions', details: String(error) },
      { status: 500 },
    );
  }
}
