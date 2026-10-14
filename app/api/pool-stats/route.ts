import { NextResponse } from 'next/server';

import { getLlamaPools } from '../../lib/defillamaPools';

// DefiLlama project names per protocol
const PROJECT_MAP: Record<string, string[]> = {
  'Aerodrome':    ['aerodrome-slipstream', 'aerodrome-v1'],
  'Velodrome':    ['velodrome-slipstream', 'velodrome-v1'],
  'Uniswap V3':  ['uniswap-v3'],
  'Orca':        ['orca-dex'],
  'Raydium':     ['raydium-amm'],
  'Bluefin':     ['bluefin-spot'],
  'Cetus':       ['cetus-clmm'],
  'HyperSwap':   ['hyperswap-v3'],
  'KittenSwap':  ['kittenswap'],
  'ProjectX':    ['project-x'],
  'PancakeSwap': ['pancakeswap-amm-v3'],
};

// Chain name mapping (app name → DefiLlama name)
const CHAIN_MAP: Record<string, string> = {
  'Base':        'Base',
  'Ethereum':    'Ethereum',
  'Arbitrum':    'Arbitrum',
  'Polygon':     'Polygon',
  'Optimism':    'Optimism',
  'Solana':      'Solana',
  'Sui':         'Sui',
  'HyperEVM':    'Hyperliquid L1',
  'BNB Chain':   'BSC',
};

// Normalize pair string to sorted uppercase tokens joined by '-'
// Handles both "WETH / USDC" and "WETH-USDC" inputs
function normalizePair(pair: string): string {
  return pair.replace(/\s*\/\s*/g, '-').split('-').map(t => t.trim().toUpperCase()).sort().join('-');
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const protocol = searchParams.get('protocol') ?? '';
  const chain = searchParams.get('chain') ?? '';
  const pair = searchParams.get('pair') ?? '';

  const projects = PROJECT_MAP[protocol];
  if (!projects || projects.length === 0) {
    return NextResponse.json({ tvlUsd: null, volumeUsd1d: null, feesUsd1d: null });
  }

  const llamaChain = CHAIN_MAP[chain] ?? chain;
  const normalizedPair = normalizePair(pair);

  try {
    // One shared, stored copy of DeFiLlama's pool list (app/lib/defillamaPools.ts).
    // `basis` says whether the figures are live, the last known copy, or unavailable.
    const ll = await getLlamaPools(projects);
    if (ll.basis === 'unavailable') {
      return NextResponse.json({ tvlUsd: null, volumeUsd1d: null, feesUsd1d: null, basis: ll.basis });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: { data: any[] } = { data: ll.pools };
    const pools: Array<{
      project: string;
      chain: string;
      symbol: string;
      tvlUsd: number;
      apyBase: number | null;
      volumeUsd1d?: number | null;
    }> = json.data ?? [];

    // Filter to matching project + chain
    const matching = pools.filter(p => projects.includes(p.project) && p.chain === llamaChain);

    if (matching.length === 0) {
      return NextResponse.json({ tvlUsd: null, volumeUsd1d: null, feesUsd1d: null });
    }

    // Find best pool by pair symbol match, fallback to highest TVL in project
    const pool = matching.find(p => normalizePair(p.symbol) === normalizedPair)
      ?? matching.sort((a, b) => b.tvlUsd - a.tvlUsd)[0];

    const feesUsd1d = pool.tvlUsd * (pool.apyBase ?? 0) / 100 / 365;
    return NextResponse.json({
      tvlUsd: pool.tvlUsd,
      volumeUsd1d: pool.volumeUsd1d ?? null,
      feesUsd1d: Math.round(feesUsd1d * 100) / 100,
      basis: ll.basis,
      ...(ll.basis === 'last-known' && ll.at ? { asOf: ll.at } : {}),
    });
  } catch (err) {
    console.error('[pool-stats] Error fetching DefiLlama:', err);
    return NextResponse.json({ tvlUsd: null, volumeUsd1d: null, feesUsd1d: null });
  }
}
