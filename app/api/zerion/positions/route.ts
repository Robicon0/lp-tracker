import { NextResponse } from 'next/server';

// Zerion hybrid fallback. Returns positions for protocols DefiDesh does NOT
// have a deep integration for, so wallets pasted via scan / Watch never show
// $0 even when their assets sit on long-tail DeFi (Aave, Compound, Curve,
// Pendle, Convex, Yearn, Lido, etc.).
//
// AUTH: Authorization: Basic <base64(ZERION_API_KEY + ":")>
// FAIL-SILENTLY contract: any error path returns `{ positions: [] }` with
// HTTP 200 so the dashboard never surfaces a Zerion failure to the user.

// Supported protocols (case-insensitive substring match on Zerion's
// `attributes.protocol` / `attributes.application_metadata.name`). Any
// position whose protocol matches one of these is OWNED by an existing
// deep integration and must NOT appear in the fallback section — that
// would double-count it. Keep this list in sync with the dashboard's
// known protocol set.
const SUPPORTED_PROTOCOLS = [
  'aerodrome', 'velodrome',
  'uniswap',   'pancakeswap',
  'bluefin',   'orca',        'raydium',
  'hyperswap', 'kittenswap',  'projectx', 'prjx',
  'cetus',     'momentum',
] as const;

const ZERION_TIMEOUT_MS = 10_000;

export interface ZerionPosition {
  id: string;
  protocol: string;
  chain: string;
  pair: string;
  usdValue: number;
  apy: number | null;
  tokens: string[];
  positionType: string;
  source: 'zerion';
}

// Minimal Zerion JSON:API shape we depend on. Fields not listed are
// ignored — defensive parsing only touches what we actually use.
interface ZerionEnvelope {
  data?: Array<{
    id: string;
    type: string;
    attributes?: {
      name?: string;
      value?: number;
      protocol?: string;
      position_type?: string;
      fungible_info?: {
        name?: string;
        symbol?: string;
      };
      application_metadata?: {
        name?: string;
        url?: string;
      };
      apy?: number;
      changes?: { absolute_1d?: number; percent_1d?: number };
      flags?: { displayable?: boolean; is_trash?: boolean };
    };
    relationships?: {
      chain?: { data?: { id?: string } };
    };
  }>;
  errors?: Array<{ title?: string; detail?: string }>;
}

function isSupportedProtocol(name: string): boolean {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!key) return false;
  return SUPPORTED_PROTOCOLS.some((s) => key.includes(s));
}

// Map Zerion's chain ids ("binance-smart-chain", "polygon", …) to the
// display strings the dashboard already uses for badge styling.
const ZERION_CHAIN_MAP: Record<string, string> = {
  'ethereum':            'Ethereum',
  'arbitrum':            'Arbitrum',
  'optimism':            'Optimism',
  'polygon':             'Polygon',
  'binance-smart-chain': 'BNB Chain',
  'avalanche':           'Avalanche',
  'base':                'Base',
  'fantom':              'Fantom',
  'gnosis':              'Gnosis',
  'celo':                'Celo',
  'zksync-era':          'zkSync',
  'linea':               'Linea',
  'scroll':              'Scroll',
  'blast':               'Blast',
  'mode':                'Mode',
  'mantle':              'Mantle',
  'manta':               'Manta',
  'metis':               'Metis',
  'sonic':               'Sonic',
  'unichain':            'Unichain',
};

function mapChain(zerionChainId: string): string {
  if (!zerionChainId) return 'Unknown';
  return ZERION_CHAIN_MAP[zerionChainId] ?? zerionChainId
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = searchParams.get('account');

  // Guard: account must be a valid EVM address (Zerion is EVM-only here —
  // Solana / Sui have their own deep integrations and don't need fallback).
  if (!account || !/^0x[a-fA-F0-9]{40}$/.test(account)) {
    return NextResponse.json({ positions: [] });
  }

  const apiKey = process.env.ZERION_API_KEY;
  if (!apiKey) {
    console.warn('[zerion/positions] ZERION_API_KEY not configured — returning empty');
    return NextResponse.json({ positions: [] });
  }

  const url = `https://api.zerion.io/v1/wallets/${account.toLowerCase()}/positions/?filter%5Btrash%5D=only_non_trash&currency=usd`;
  const auth = `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), ZERION_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: auth,
        accept:        'application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      console.warn(`[zerion/positions] HTTP ${res.status} for ${account.slice(0, 6)}…${account.slice(-4)}`);
      return NextResponse.json({ positions: [] });
    }

    const data = (await res.json()) as ZerionEnvelope;
    const items = data.data ?? [];

    const positions: ZerionPosition[] = [];
    for (const item of items) {
      const attrs = item.attributes;
      if (!attrs) continue;
      if (attrs.flags?.is_trash) continue;
      if (attrs.flags?.displayable === false) continue;

      const protocolName =
        attrs.protocol ?? attrs.application_metadata?.name ?? '';
      if (isSupportedProtocol(protocolName)) continue;

      const usdValue = Number(attrs.value ?? 0);
      if (!Number.isFinite(usdValue) || usdValue <= 0) continue;

      const chainId = item.relationships?.chain?.data?.id ?? '';
      const chain   = mapChain(chainId);

      const symbol = attrs.fungible_info?.symbol ?? '';
      const tokens = symbol ? [symbol] : [];
      const pair   = symbol || attrs.name || 'Unknown';

      const apy = typeof attrs.apy === 'number' && Number.isFinite(attrs.apy)
        ? attrs.apy
        : null;

      positions.push({
        id:           `zerion-${item.id}`,
        protocol:     protocolName || 'Unknown',
        chain,
        pair,
        usdValue:     Math.round(usdValue * 100) / 100,
        apy,
        tokens,
        positionType: attrs.position_type ?? 'unknown',
        source:       'zerion',
      });
    }

    // Sort by USD descending — biggest fallback positions first.
    positions.sort((a, b) => b.usdValue - a.usdValue);

    console.log(`[zerion/positions] ${account.slice(0, 6)}…${account.slice(-4)}: ${items.length} total, ${positions.length} after filter`);
    return NextResponse.json({ positions });
  } catch (err) {
    clearTimeout(timeoutId);
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[zerion/positions] fetch failed: ${msg}`);
    return NextResponse.json({ positions: [] });
  }
}
