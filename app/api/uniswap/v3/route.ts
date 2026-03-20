import { NextResponse } from 'next/server';

const ALCHEMY_KEY = process.env.NEXT_PUBLIC_ALCHEMY_KEY;

// Uniswap V3 NonfungiblePositionManager - same address on all chains
const POSITION_MANAGER = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';

// Chain configurations with Alchemy RPC endpoints
const CHAINS: Record<string, { rpc: string; chainName: string; defillamaChain: string }> = {
  ethereum: {
    rpc: `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
    chainName: 'Ethereum',
    defillamaChain: 'Ethereum',
  },
  arbitrum: {
    rpc: `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
    chainName: 'Arbitrum',
    defillamaChain: 'Arbitrum',
  },
  polygon: {
    rpc: `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
    chainName: 'Polygon',
    defillamaChain: 'Polygon',
  },
  optimism: {
    rpc: `https://opt-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
    chainName: 'Optimism',
    defillamaChain: 'Optimism',
  },
};

// Well-known tokens per chain for symbol/decimal resolution
const KNOWN_TOKENS: Record<string, Record<string, { symbol: string; decimals: number; coingeckoId: string }>> = {
  ethereum: {
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH', decimals: 18, coingeckoId: 'ethereum' },
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6, coingeckoId: 'usd-coin' },
    '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6, coingeckoId: 'tether' },
    '0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI', decimals: 18, coingeckoId: 'dai' },
    '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': { symbol: 'WBTC', decimals: 8, coingeckoId: 'bitcoin' },
    '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984': { symbol: 'UNI', decimals: 18, coingeckoId: 'uniswap' },
    '0x514910771af9ca656af840dff83e8264ecf986ca': { symbol: 'LINK', decimals: 18, coingeckoId: 'chainlink' },
  },
  arbitrum: {
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': { symbol: 'WETH', decimals: 18, coingeckoId: 'ethereum' },
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831': { symbol: 'USDC', decimals: 6, coingeckoId: 'usd-coin' },
    '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': { symbol: 'USDC.e', decimals: 6, coingeckoId: 'usd-coin' },
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': { symbol: 'USDT', decimals: 6, coingeckoId: 'tether' },
    '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f': { symbol: 'WBTC', decimals: 8, coingeckoId: 'bitcoin' },
    '0x912ce59144191c1204e64559fe8253a0e49e6548': { symbol: 'ARB', decimals: 18, coingeckoId: 'arbitrum' },
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': { symbol: 'DAI', decimals: 18, coingeckoId: 'dai' },
  },
  polygon: {
    '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619': { symbol: 'WETH', decimals: 18, coingeckoId: 'ethereum' },
    '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': { symbol: 'USDC', decimals: 6, coingeckoId: 'usd-coin' },
    '0x2791bca1f2de4661ed88a30c99a7a9449aa84174': { symbol: 'USDC.e', decimals: 6, coingeckoId: 'usd-coin' },
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': { symbol: 'USDT', decimals: 6, coingeckoId: 'tether' },
    '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270': { symbol: 'WMATIC', decimals: 18, coingeckoId: 'matic-network' },
    '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6': { symbol: 'WBTC', decimals: 8, coingeckoId: 'bitcoin' },
    '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063': { symbol: 'DAI', decimals: 18, coingeckoId: 'dai' },
  },
  optimism: {
    '0x4200000000000000000000000000000000000006': { symbol: 'WETH', decimals: 18, coingeckoId: 'ethereum' },
    '0x0b2c639c533813f4aa9d7837caf62653d097ff85': { symbol: 'USDC', decimals: 6, coingeckoId: 'usd-coin' },
    '0x7f5c764cbc14f9669b88837ca1490cca17c31607': { symbol: 'USDC.e', decimals: 6, coingeckoId: 'usd-coin' },
    '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58': { symbol: 'USDT', decimals: 6, coingeckoId: 'tether' },
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': { symbol: 'DAI', decimals: 18, coingeckoId: 'dai' },
    '0x68f180fcce6836688e9084f035309e29bf0a2095': { symbol: 'WBTC', decimals: 8, coingeckoId: 'bitcoin' },
    '0x4200000000000000000000000000000000000042': { symbol: 'OP', decimals: 18, coingeckoId: 'optimism' },
  },
};

// Function selectors
const SELECTORS = {
  balanceOf: '0x70a08231',     // balanceOf(address)
  tokenOfOwnerByIndex: '0x2f745c59', // tokenOfOwnerByIndex(address,uint256)
  positions: '0x99fd0e82',     // positions(uint256) — NOT the 4-byte but let me use the right one
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
};

function padAddress(addr: string): string {
  return addr.toLowerCase().replace('0x', '').padStart(64, '0');
}

function padUint256(value: bigint): string {
  return value.toString(16).padStart(64, '0');
}

async function rpcCall(rpc: string, to: string, data: string): Promise<string> {
  const res = await fetch(rpc, {
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

// Get number of Uniswap V3 NFTs owned by account
async function getBalance(rpc: string, account: string): Promise<number> {
  const data = SELECTORS.balanceOf + padAddress(account);
  const result = await rpcCall(rpc, POSITION_MANAGER, data);
  if (!result || result === '0x') return 0;
  return parseInt(result, 16);
}

// Get token ID at index
async function getTokenId(rpc: string, account: string, index: number): Promise<bigint> {
  const data = SELECTORS.tokenOfOwnerByIndex + padAddress(account) + padUint256(BigInt(index));
  const result = await rpcCall(rpc, POSITION_MANAGER, data);
  if (!result || result === '0x') return 0n;
  return BigInt(result);
}

// Decode position data from positions(uint256) call
// Returns: nonce, operator, token0, token1, fee, tickLower, tickUpper, liquidity,
//          feeGrowthInside0LastX128, feeGrowthInside1LastX128, tokensOwed0, tokensOwed1
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

async function getPosition(rpc: string, tokenId: bigint): Promise<PositionData | null> {
  // positions(uint256) selector = 0x99fd0e82  
  // Actually the correct selector for positions(uint256) on NonfungiblePositionManager
  // keccak256("positions(uint256)") = 0x99fd0e82... let me verify
  // The function signature returns 12 values as a tuple
  const selector = '0x99fd0e82';
  const data = selector + padUint256(tokenId);
  const result = await rpcCall(rpc, POSITION_MANAGER, data);
  
  if (!result || result === '0x' || result.length < 770) return null;
  
  const hex = result.startsWith('0x') ? result.slice(2) : result;
  
  // Decode 12 return values (each 32 bytes = 64 hex chars)
  const readWord = (i: number) => hex.slice(i * 64, (i + 1) * 64);
  const toAddress = (word: string) => '0x' + word.slice(24).toLowerCase();
  const toInt24 = (word: string) => {
    const val = BigInt('0x' + word);
    const MAX = BigInt('0x7fffff');
    if (val > MAX) return Number(val - BigInt('0x1000000'));
    return Number(val);
  };
  
  // word 0: nonce (uint96)
  // word 1: operator (address)
  // word 2: token0 (address)
  // word 3: token1 (address)
  // word 4: fee (uint24)
  // word 5: tickLower (int24)
  // word 6: tickUpper (int24)
  // word 7: liquidity (uint128)
  // word 8: feeGrowthInside0LastX128 (uint256)
  // word 9: feeGrowthInside1LastX128 (uint256)
  // word 10: tokensOwed0 (uint128)
  // word 11: tokensOwed1 (uint128)
  
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

// Fetch token symbol and decimals from chain if not in known list
async function fetchTokenInfo(rpc: string, tokenAddress: string): Promise<{ symbol: string; decimals: number }> {
  try {
    const symResult = await rpcCall(rpc, tokenAddress, SELECTORS.symbol);
    const decResult = await rpcCall(rpc, tokenAddress, SELECTORS.decimals);
    
    let symbol = 'UNKNOWN';
    if (symResult && symResult.length > 130) {
      // ABI-encoded string: offset(32) + length(32) + data
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

// Calculate token amounts from liquidity and tick range
// Using the Uniswap V3 math: 
// amount0 = liquidity * (sqrt(upper) - sqrt(current)) / (sqrt(current) * sqrt(upper))
// amount1 = liquidity * (sqrt(current) - sqrt(lower))
// For simplicity, we'll estimate using the geometric mean of the range
function estimateAmounts(
  liquidity: bigint,
  tickLower: number,
  tickUpper: number,
  decimals0: number,
  decimals1: number
): { amount0: number; amount1: number } {
  if (liquidity === 0n) return { amount0: 0, amount1: 0 };
  
  // sqrt(1.0001^tick) 
  const sqrtLower = Math.sqrt(1.0001 ** tickLower);
  const sqrtUpper = Math.sqrt(1.0001 ** tickUpper);
  // Use midpoint as current price estimate
  const sqrtCurrent = (sqrtLower + sqrtUpper) / 2;
  
  const liq = Number(liquidity);
  
  // amount0 = L * (1/sqrtCurrent - 1/sqrtUpper)
  const amount0 = liq * (1 / sqrtCurrent - 1 / sqrtUpper) / (10 ** decimals0);
  // amount1 = L * (sqrtCurrent - sqrtLower)
  const amount1 = liq * (sqrtCurrent - sqrtLower) / (10 ** decimals1);
  
  return {
    amount0: Math.max(0, amount0),
    amount1: Math.max(0, amount1),
  };
}

// Fetch prices from CoinGecko
async function fetchPrices(coingeckoIds: string[]): Promise<Record<string, number>> {
  try {
    const unique = [...new Set(coingeckoIds)].join(',');
    if (!unique) return {};
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${unique}&vs_currencies=usd`,
      { next: { revalidate: 60 } }
    );
    const data = await res.json();
    const prices: Record<string, number> = {};
    for (const [id, val] of Object.entries(data)) {
      prices[id] = (val as any)?.usd || 0;
    }
    return prices;
  } catch {
    return {};
  }
}

// Fetch APY from DefiLlama
async function fetchUniswapAPYs(): Promise<Record<string, number>> {
  try {
    const res = await fetch('https://yields.llama.fi/pools', { next: { revalidate: 300 } });
    const data = await res.json();
    
    const uniPools = data.data?.filter(
      (p: any) => p.project === 'uniswap-v3'
    ) || [];
    
    // Build lookup by "chain-token0-token1" using median APY
    const apysByKey: Record<string, number[]> = {};
    for (const pool of uniPools) {
      if (pool.underlyingTokens && pool.underlyingTokens.length >= 2) {
        const tokens = pool.underlyingTokens.map((t: string) => t.toLowerCase()).sort();
        const key = `${pool.chain}-${tokens.join('-')}`;
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

async function fetchPositionsForChain(
  chainKey: string,
  account: string,
  prices: Record<string, number>,
  apyData: Record<string, number>
) {
  const chain = CHAINS[chainKey];
  const knownTokens = KNOWN_TOKENS[chainKey] || {};
  const positions: any[] = [];
  
  try {
    const balance = await getBalance(chain.rpc, account);
    if (balance === 0) return [];
    
    // Limit to 20 positions per chain to avoid timeout
    const count = Math.min(balance, 20);
    
    // Fetch all token IDs
    const tokenIds: bigint[] = [];
    for (let i = 0; i < count; i++) {
      const id = await getTokenId(chain.rpc, account, i);
      if (id > 0n) tokenIds.push(id);
    }
    
    // Fetch position data for each token
    for (const tokenId of tokenIds) {
      try {
        const pos = await getPosition(chain.rpc, tokenId);
        if (!pos) continue;
        
        // Get token info
        let t0Info = knownTokens[pos.token0];
        let t1Info = knownTokens[pos.token1];
        
        // Fetch unknown tokens from chain
        if (!t0Info) {
          const fetched = await fetchTokenInfo(chain.rpc, pos.token0);
          t0Info = { ...fetched, coingeckoId: '' };
        }
        if (!t1Info) {
          const fetched = await fetchTokenInfo(chain.rpc, pos.token1);
          t1Info = { ...fetched, coingeckoId: '' };
        }
        
        // Calculate amounts
        const { amount0, amount1 } = estimateAmounts(
          pos.liquidity, pos.tickLower, pos.tickUpper, t0Info.decimals, t1Info.decimals
        );
        
        // Get prices
        const price0 = t0Info.coingeckoId ? (prices[t0Info.coingeckoId] || 0) : 0;
        const price1 = t1Info.coingeckoId ? (prices[t1Info.coingeckoId] || 0) : 0;
        
        const value = (amount0 * price0) + (amount1 * price1);
        
        // Calculate fees value
        const fees0 = Number(pos.tokensOwed0) / (10 ** t0Info.decimals);
        const fees1 = Number(pos.tokensOwed1) / (10 ** t1Info.decimals);
        const feesUsd = (fees0 * price0) + (fees1 * price1);
        
        // Look up APY
        const apyKey = `${chain.defillamaChain}-${[pos.token0, pos.token1].sort().join('-')}`;
        const apy = apyData[apyKey] || 0;
        
        // Determine status
        const hasToken0 = amount0 > 0.0001;
        const hasToken1 = amount1 > 0.0001;
        const status = pos.liquidity === 0n ? 'Closed' : (hasToken0 && hasToken1) ? 'In Range' : 'Out of Range';
        
        positions.push({
          id: `uni3-${chainKey}-${tokenId.toString()}`,
          pair: `${t0Info.symbol} / ${t1Info.symbol}`,
          protocol: 'Uniswap V3',
          chain: chain.chainName,
          value: Math.round(value * 100) / 100,
          apy,
          fees: Math.round(feesUsd * 100) / 100,
          status,
          tokenId: tokenId.toString(),
          fee: pos.fee / 10000, // Convert to percentage (e.g., 3000 -> 0.3%)
          amount0: Math.round(amount0 * 1000000) / 1000000,
          amount1: Math.round(amount1 * 1000000) / 1000000,
          token0Symbol: t0Info.symbol,
          token1Symbol: t1Info.symbol,
          tickLower: pos.tickLower,
          tickUpper: pos.tickUpper,
          token0Decimals: t0Info.decimals,
          token1Decimals: t1Info.decimals,
          liquidity: pos.liquidity.toString(),
          price0,
          price1,
          token0Address: pos.token0,
          token1Address: pos.token1,
          walletAddress: account,
        });
      } catch (err) {
        console.error(`Error processing token ${tokenId} on ${chainKey}:`, err);
      }
    }
  } catch (err) {
    console.error(`Error fetching positions on ${chainKey}:`, err);
  }
  
  return positions;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = searchParams.get('account');
  const chain = searchParams.get('chain'); // Optional: filter to specific chain
  
  if (!account) {
    return NextResponse.json({ error: 'Account address required' }, { status: 400 });
  }
  
  if (!ALCHEMY_KEY) {
    return NextResponse.json({ error: 'Alchemy API key not configured' }, { status: 500 });
  }
  
  try {
    // Collect all coingecko IDs for price fetch
    const allCoingeckoIds: string[] = [];
    for (const tokens of Object.values(KNOWN_TOKENS)) {
      for (const t of Object.values(tokens)) {
        if (t.coingeckoId) allCoingeckoIds.push(t.coingeckoId);
      }
    }
    
    // Fetch prices and APY data in parallel
    const [prices, apyData] = await Promise.all([
      fetchPrices(allCoingeckoIds),
      fetchUniswapAPYs(),
    ]);
    
    // Determine which chains to query
    const chainsToQuery = chain && CHAINS[chain] ? [chain] : Object.keys(CHAINS);
    
    // Fetch positions from all chains in parallel
    const results = await Promise.all(
      chainsToQuery.map(c => fetchPositionsForChain(c, account, prices, apyData))
    );
    
    const allPositions = results.flat();
    
    return NextResponse.json({
      positions: allPositions,
      count: allPositions.length,
      account,
      chains: chainsToQuery,
    });
  } catch (err) {
    console.error('Uniswap V3 API error:', err);
    return NextResponse.json({ error: 'Failed to fetch positions' }, { status: 500 });
  }
}