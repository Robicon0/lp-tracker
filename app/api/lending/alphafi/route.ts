import { NextResponse } from 'next/server';

// AlphaFi / AlphaLend on Sui — raw Sui RPC implementation
// AlphaLend has no public REST API; positions are tracked via on-chain PositionCap objects.
//
// Package: 0xee754fc0c6d977403c9218cedbfffed033b4b42b50a65c2c3f1c7be13efeafd2
// Protocol object: 0x01d9cf05d65fa3a9bb7163095139120e3c4e414dfbab153a49779a7d14010b93
//
// A PositionCap in the user's wallet proves they have an open lending position.
// The cap's fields reference the actual position data which is then decoded.

const SUI_RPC = process.env.SUI_RPC_URL ?? 'https://fullnode.mainnet.sui.io:443';

const ALPHAFI_PACKAGE = '0xee754fc0c6d977403c9218cedbfffed033b4b42b50a65c2c3f1c7be13efeafd2';
const POSITION_CAP_TYPE = `${ALPHAFI_PACKAGE}::position::PositionCap`;

// Known AlphaFi market IDs → token symbol mapping
// These are resolved dynamically below, but we keep a static fallback map
const MARKET_SYMBOL: Record<string, string> = {
  SUI:   'SUI',
  USDC:  'USDC',
  USDT:  'USDT',
  WETH:  'WETH',
  wUSDC: 'USDC',
};

async function suiCall(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(SUI_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json() as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

// Fetch all PositionCap objects owned by the account (pagination loop)
async function getPositionCaps(account: string): Promise<Record<string, unknown>[]> {
  const caps: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  let page = 0;
  do {
    page++;
    const result = await suiCall('suix_getOwnedObjects', [
      account,
      {
        filter: { StructType: POSITION_CAP_TYPE },
        options: { showContent: true, showType: true },
      },
      cursor,
      50,
    ]) as { data?: Array<{ data?: Record<string, unknown> }>; nextCursor?: string; hasNextPage?: boolean };

    const items = result?.data ?? [];
    for (const item of items) {
      if (item.data) caps.push(item.data);
    }
    cursor = (result?.hasNextPage && result?.nextCursor) ? result.nextCursor : null;
  } while (cursor && page < 10);

  return caps;
}

// Get USD price for a coin type via CoinGecko
const CG_IDS: Record<string, string> = {
  SUI:  'sui',
  USDC: 'usd-coin',
  USDT: 'tether',
  WETH: 'ethereum',
  ETH:  'ethereum',
};
const STABLE: Record<string, number> = { USDC: 1, USDT: 1, DAI: 1 };

async function getPriceUsd(symbol: string): Promise<number> {
  const sym = symbol.toUpperCase().replace('WUSDC', 'USDC');
  if (STABLE[sym] !== undefined) return STABLE[sym];
  const id = CG_IDS[sym];
  if (!id) return 0;
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
    ).then((r) => r.json()) as Record<string, { usd?: number }>;
    return res[id]?.usd ?? 0;
  } catch (err) {
    console.error(`[alphafi/route] CoinGecko price failed for ${symbol}:`, err);
    return 0;
  }
}

// Extract symbol from a Sui coin type string like "0x2::sui::SUI" or "...::usdc::USDC"
function symbolFromCoinType(coinType: string): string {
  const parts = coinType.split('::');
  const raw = parts[parts.length - 1] ?? coinType;
  // Normalize wUSDC -> USDC
  if (raw.toLowerCase() === 'wusdc') return 'USDC';
  return raw.toUpperCase();
}

// Decode an I32 from Move bits encoding
function decodeI32(bits: number): number {
  return bits > 2147483647 ? bits - 4294967296 : bits;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = searchParams.get('account');

  if (!account) return NextResponse.json({ error: 'account required' }, { status: 400 });

  try {
    console.log(`[alphafi/route] Fetching PositionCap objects for ${account}`);
    const caps = await getPositionCaps(account);
    console.log(`[alphafi/route] Found ${caps.length} PositionCap objects`);

    if (caps.length === 0) {
      return NextResponse.json({ supplies: [], borrows: [], protocol: 'AlphaFi', chain: 'Sui' });
    }

    const supplies: Array<{ symbol: string; amount: number; usdValue: number; apy: number }> = [];
    const borrows:  Array<{ symbol: string; amount: number; usdValue: number; apy: number }> = [];

    for (const cap of caps) {
      try {
        console.log(`[alphafi/route] PositionCap object type: ${cap.type}, id: ${(cap as Record<string, Record<string,string>>).objectId}`);
        const content = (cap as Record<string, unknown>).content as Record<string, unknown> | undefined;
        if (!content) {
          console.warn('[alphafi/route] PositionCap has no content field');
          continue;
        }

        const fields = (content.fields as Record<string, unknown>) ?? {};
        console.log(`[alphafi/route] PositionCap fields: ${JSON.stringify(fields).slice(0, 500)}`);

        // Try to find the referenced position object ID
        // Common patterns: fields.position_id, fields.id (nested), or direct balance fields
        const positionRef = fields.position_id ?? fields.position ?? null;
        if (positionRef) {
          // Fetch the actual position object
          const posId = typeof positionRef === 'string' ? positionRef
            : (positionRef as Record<string, string>).id ?? String(positionRef);
          console.log(`[alphafi/route] Fetching position object: ${posId}`);

          const posObj = await suiCall('sui_getObject', [
            posId,
            { showContent: true, showType: true },
          ]) as { data?: { content?: { fields?: Record<string, unknown>; dataType?: string }; type?: string } };

          const posFields = posObj?.data?.content?.fields ?? {};
          console.log(`[alphafi/route] Position object fields: ${JSON.stringify(posFields).slice(0, 800)}`);

          // Extract supplied/borrowed assets from position fields
          // AlphaLend positions store collateral and borrow amounts per market
          await extractPositionAssets(posFields, supplies, borrows);
        } else {
          // PositionCap may directly embed balance info
          await extractPositionAssets(fields, supplies, borrows);
        }
      } catch (err) {
        console.error('[alphafi/route] Failed to process PositionCap:', err);
      }
    }

    console.log(`[alphafi/route] Result: ${supplies.length} supplies, ${borrows.length} borrows`);
    return NextResponse.json({ supplies, borrows, protocol: 'AlphaFi', chain: 'Sui' });
  } catch (err) {
    console.error('[alphafi/route] fetch failed:', err);
    return NextResponse.json({ supplies: [], borrows: [], error: String(err) });
  }
}

// Try to decode position assets from a Move struct fields map
async function extractPositionAssets(
  fields: Record<string, unknown>,
  supplies: Array<{ symbol: string; amount: number; usdValue: number; apy: number }>,
  borrows:  Array<{ symbol: string; amount: number; usdValue: number; apy: number }>,
): Promise<void> {
  // Pattern 1: collaterals / borrows as Table or vector of { coin_type, amount }
  const collateralField = fields.collaterals ?? fields.supplied ?? fields.deposits ?? null;
  const borrowField     = fields.borrows     ?? fields.borrowed ?? fields.debts    ?? null;

  if (collateralField) {
    const items = normalizeAssetList(collateralField);
    for (const item of items) {
      const asset = await decodeAssetItem(item);
      if (asset) supplies.push(asset);
    }
  }

  if (borrowField) {
    const items = normalizeAssetList(borrowField);
    for (const item of items) {
      const asset = await decodeAssetItem(item);
      if (asset) borrows.push(asset);
    }
  }

  // Pattern 2: single-asset position (coin_type + amount at top level)
  if (supplies.length === 0 && borrows.length === 0) {
    const coinType = fields.coin_type ?? fields.asset ?? fields.token ?? null;
    const rawAmt   = fields.supplied_amount ?? fields.amount ?? fields.balance ?? null;
    if (coinType && rawAmt != null) {
      const symbol = symbolFromCoinType(String((coinType as Record<string, string>)?.name ?? coinType));
      const decimals = symbol === 'SUI' ? 9 : 6;
      const amount = Number(rawAmt) / Math.pow(10, decimals);
      if (amount > 0.000001) {
        const price = await getPriceUsd(symbol);
        supplies.push({ symbol, amount, usdValue: amount * price, apy: 0 });
      }
    }
  }
}

// Normalize whatever Move returns as an asset collection into an array of items
function normalizeAssetList(field: unknown): Record<string, unknown>[] {
  if (Array.isArray(field)) return field as Record<string, unknown>[];
  // Table stored as { fields: { id: ..., size: ... } } — cannot iterate directly without dynamic field queries
  if (typeof field === 'object' && field !== null) {
    const f = field as Record<string, unknown>;
    if (Array.isArray(f.contents)) return f.contents as Record<string, unknown>[];
    if (Array.isArray(f.vec))      return f.vec as Record<string, unknown>[];
  }
  return [];
}

// Decode a single asset item from a Move struct
async function decodeAssetItem(
  item: Record<string, unknown>,
): Promise<{ symbol: string; amount: number; usdValue: number; apy: number } | null> {
  try {
    const innerFields = (item.fields as Record<string, unknown>) ?? item;
    const coinType    = innerFields.coin_type ?? innerFields.asset_type ?? innerFields.token ?? null;
    const rawAmt      = innerFields.amount ?? innerFields.value ?? innerFields.balance ?? null;
    if (!coinType || rawAmt == null) return null;

    const symbol   = symbolFromCoinType(String((coinType as Record<string, string>)?.name ?? coinType));
    const decimals = symbol === 'SUI' ? 9 : 6;
    const amount   = Number(rawAmt) / Math.pow(10, decimals);
    if (amount < 0.000001) return null;

    const price = await getPriceUsd(symbol);
    return { symbol, amount, usdValue: amount * price, apy: 0 };
  } catch {
    return null;
  }
}
