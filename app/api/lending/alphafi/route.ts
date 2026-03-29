import { NextResponse } from 'next/server';

// AlphaFi / AlphaLend on Sui — raw Sui RPC implementation
// Correct package (verified from AlphaFiTech/alphalend-contracts-interfaces on GitHub):
//   Package: 0xd631cd66138909636fc3f73ed75820d0c5b76332d1644608ed1c85ea2b8219b4
//
// User position flow:
//   1. User wallet owns PositionCap objects (StructType: <pkg>::position::PositionCap)
//   2. PositionCap.fields.position_id → ID of the actual Position object
//   3. Position.fields.collaterals (VecMap<u64,u64>) + total_collateral_usd (Number)
//   4. Position.fields.loans (vector<Borrow>) + total_loan_usd (Number)
//
// Borrow struct: { coin_type: TypeName, market_id: u64, amount: u64, ... }
// Number type (alphafi_stdlib::math::Number): { fields: { value: string } } scaled by 10^18

const SUI_RPC = process.env.SUI_RPC_URL ?? 'https://fullnode.mainnet.sui.io:443';
const ALPHAFI_PKG = '0xd631cd66138909636fc3f73ed75820d0c5b76332d1644608ed1c85ea2b8219b4';
const POSITION_CAP_TYPE = `${ALPHAFI_PKG}::position::PositionCap`;

async function suiPost(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(SUI_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json() as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(`Sui RPC error: ${json.error.message}`);
  return json.result;
}

// Decode alphafi_stdlib Number (value field / 10^18)
function decodeNumber(num: unknown): number {
  if (num == null) return 0;
  if (typeof num === 'number') return num;
  if (typeof num === 'string') return Number(num) / 1e18;
  const fields = (num as Record<string, unknown>).fields as Record<string, unknown> | undefined;
  if (fields?.value != null) return Number(fields.value) / 1e18;
  return 0;
}

// Extract symbol from Sui TypeName string like "0x2::sui::SUI" or wrapper struct
function symbolFromTypeName(coinType: unknown): string {
  if (coinType == null) return 'UNKNOWN';
  let typeStr = '';
  if (typeof coinType === 'string') {
    typeStr = coinType;
  } else {
    const f = (coinType as Record<string, unknown>).fields as Record<string, unknown> | undefined;
    typeStr = String(f?.name ?? coinType);
  }
  const parts = typeStr.split('::');
  const raw = parts[parts.length - 1] ?? typeStr;
  return raw.toUpperCase().replace('WUSDC', 'USDC');
}

const STABLE: Record<string, number> = { USDC: 1, USDT: 1, DAI: 1, WUSDC: 1 };
const CG_IDS: Record<string, string> = {
  SUI: 'sui', WETH: 'ethereum', ETH: 'ethereum', BTC: 'bitcoin', WBTC: 'bitcoin',
};

async function getPriceUsd(symbol: string): Promise<number> {
  const s = symbol.toUpperCase();
  if (STABLE[s] !== undefined) return STABLE[s];
  const id = CG_IDS[s];
  if (!id) return 0;
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`)
      .then(res => res.json()) as Record<string, { usd?: number }>;
    return r[id]?.usd ?? 0;
  } catch (err) {
    console.error(`[alphafi/route] CoinGecko failed for ${symbol}:`, err);
    return 0;
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = searchParams.get('account');
  if (!account) return NextResponse.json({ error: 'account required' }, { status: 400 });

  try {
    console.log(`[alphafi/route] Querying PositionCap objects for ${account}`);

    // Step 1: get all PositionCap objects owned by the user
    const caps: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    let page = 0;
    do {
      page++;
      const res = await suiPost('suix_getOwnedObjects', [
        account,
        { filter: { StructType: POSITION_CAP_TYPE }, options: { showContent: true, showType: true } },
        cursor,
        50,
      ]) as { data?: Array<{ data?: Record<string, unknown> }>; nextCursor?: string; hasNextPage?: boolean };
      for (const item of res?.data ?? []) {
        if (item.data) caps.push(item.data);
      }
      cursor = res?.hasNextPage ? (res.nextCursor ?? null) : null;
    } while (cursor && page < 5);

    console.log(`[alphafi/route] Found ${caps.length} PositionCap objects`);

    if (caps.length === 0) {
      return NextResponse.json({ supplies: [], borrows: [], protocol: 'AlphaFi', chain: 'Sui' });
    }

    const supplies: Array<{ symbol: string; amount: number; usdValue: number; apy: number }> = [];
    const borrows:  Array<{ symbol: string; amount: number; usdValue: number; apy: number }> = [];

    for (const cap of caps) {
      try {
        const capContent = (cap as Record<string, unknown>).content as Record<string, unknown> | undefined;
        const capFields = (capContent?.fields as Record<string, unknown>) ?? {};
        console.log(`[alphafi/route] PositionCap fields keys: ${Object.keys(capFields).join(', ')}`);

        // position_id points to the actual Position object
        const positionId = capFields.position_id as string | { id: string } | undefined;
        const posId = typeof positionId === 'string' ? positionId
          : (positionId as Record<string, string> | undefined)?.id ?? null;

        if (!posId) {
          console.warn('[alphafi/route] PositionCap missing position_id, fields:', JSON.stringify(capFields).slice(0, 300));
          continue;
        }

        console.log(`[alphafi/route] Fetching Position object: ${posId}`);
        const posObj = await suiPost('sui_getObject', [posId, { showContent: true, showType: true }]) as {
          data?: { content?: { fields?: Record<string, unknown>; dataType?: string }; type?: string };
        };

        const posFields = posObj?.data?.content?.fields ?? {};
        console.log(`[alphafi/route] Position type: ${posObj?.data?.type}`);
        console.log(`[alphafi/route] Position fields keys: ${Object.keys(posFields).join(', ')}`);

        // total_collateral_usd / total_loan_usd give overall USD values
        const totalCollateralUsd = decodeNumber(posFields.total_collateral_usd);
        const totalLoanUsd       = decodeNumber(posFields.total_loan_usd);
        console.log(`[alphafi/route] totalCollateralUsd=${totalCollateralUsd} totalLoanUsd=${totalLoanUsd}`);

        // loans: vector<Borrow> — each Borrow has coin_type, market_id, amount
        const loansRaw = (posFields.loans as unknown[]) ?? [];
        for (const loan of loansRaw) {
          try {
            const lf = (loan as Record<string, unknown>).fields as Record<string, unknown> | undefined ?? loan as Record<string, unknown>;
            const symbol   = symbolFromTypeName(lf.coin_type);
            const rawAmt   = Number(lf.amount ?? 0);
            const decimals = symbol === 'SUI' ? 9 : 6;
            const amount   = rawAmt / Math.pow(10, decimals);
            if (amount < 0.000001) continue;
            const price    = await getPriceUsd(symbol);
            borrows.push({ symbol, amount, usdValue: amount * price, apy: 0 });
            console.log(`[alphafi/route] Borrow: ${symbol} ${amount}`);
          } catch (err) {
            console.error('[alphafi/route] Loan parse error:', err);
          }
        }

        // collaterals: VecMap<u64,u64> — market_id → ctoken_amount
        // Without a market registry we can't resolve individual assets,
        // so if we have no per-asset data, create one aggregate entry from total_collateral_usd
        const colRaw = posFields.collaterals as Record<string, unknown> | null;
        const colContents = (colRaw?.fields as Record<string, unknown>)?.contents as unknown[] | undefined
          ?? (Array.isArray(colRaw) ? colRaw : null);

        if (colContents && colContents.length > 0) {
          console.log(`[alphafi/route] collaterals contents length: ${colContents.length}`);
          // Each entry: { key: marketId, value: ctokenAmount }
          // Without market registry, roll up into one entry using total_collateral_usd
          if (totalCollateralUsd > 0.01) {
            supplies.push({ symbol: 'Collateral', amount: totalCollateralUsd, usdValue: totalCollateralUsd, apy: 0 });
          }
        } else if (totalCollateralUsd > 0.01) {
          supplies.push({ symbol: 'Collateral', amount: totalCollateralUsd, usdValue: totalCollateralUsd, apy: 0 });
          console.log(`[alphafi/route] Supply aggregate: $${totalCollateralUsd.toFixed(2)}`);
        }
      } catch (err) {
        console.error('[alphafi/route] Position processing error:', err);
      }
    }

    console.log(`[alphafi/route] Result: ${supplies.length} supplies, ${borrows.length} borrows`);
    return NextResponse.json({ supplies, borrows, protocol: 'AlphaFi', chain: 'Sui' });
  } catch (err) {
    console.error('[alphafi/route] Unexpected error:', err);
    return NextResponse.json({ supplies: [], borrows: [], error: String(err) });
  }
}
