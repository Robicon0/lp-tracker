import { NextResponse } from 'next/server';

// Suilend on Sui — raw Sui RPC implementation
// Package: 0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf
//
// User positions are Obligation<T> objects owned by the user.
// Obligation fields:
//   deposits: vector<Deposit> — each has coin_type, market_value (Decimal in USD), deposited_ctoken_amount
//   borrows:  vector<Borrow>  — each has coin_type, borrowed_amount (Decimal), market_value (Decimal in USD)
//   deposited_value_usd: Decimal — total deposited USD
//   weighted_borrowed_value_usd: Decimal — total borrowed USD
//
// Decimal type (suilend): { fields: { value: string } } — u256 scaled by 10^18

const SUI_RPC = process.env.SUI_RPC_URL ?? 'https://fullnode.mainnet.sui.io:443';

// Suilend package — verified from suilend/suilend GitHub
const SUILEND_PKG = '0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf';
const OBLIGATION_TYPE = `${SUILEND_PKG}::obligation::Obligation`;

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

// Decode Suilend Decimal type (u256 / 10^18) or plain number
function decodeDecimal(val: unknown): number {
  if (val == null) return 0;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') return Number(val) / 1e18;
  // { fields: { value: "123456..." } }
  const fields = (val as Record<string, unknown>).fields as Record<string, unknown> | undefined;
  if (fields?.value != null) return Number(fields.value) / 1e18;
  return 0;
}

// Extract underlying symbol from a Sui TypeName
// e.g. "0x2::sui::SUI" → "SUI", "0xabc::usdc::USDC" → "USDC"
function symbolFromTypeName(coinType: unknown): string {
  if (coinType == null) return 'UNKNOWN';
  let typeStr = '';
  if (typeof coinType === 'string') {
    typeStr = coinType;
  } else {
    // TypeName struct: { fields: { name: "0x...::module::Type" } }
    const f = (coinType as Record<string, unknown>).fields as Record<string, unknown> | undefined;
    typeStr = String(f?.name ?? coinType);
  }
  const parts = typeStr.split('::');
  return (parts[parts.length - 1] ?? typeStr).toUpperCase();
}

// APY rates from DefiLlama for Suilend (cached)
let _suilendApyCache: { data: Record<string, number>; ts: number } | null = null;
async function getSuilendApys(): Promise<Record<string, number>> {
  const now = Date.now();
  if (_suilendApyCache && now - _suilendApyCache.ts < 300_000) return _suilendApyCache.data;
  try {
    const res = await fetch('https://yields.llama.fi/pools').then(r => r.json()) as { data?: Array<{ project: string; chain: string; symbol: string; apyBase: number | null }> };
    const apys: Record<string, number> = {};
    for (const pool of res?.data ?? []) {
      if (pool.project?.toLowerCase().includes('suilend') && pool.chain === 'Sui' && pool.apyBase != null) {
        const sym = pool.symbol.split('-')[0].trim().toUpperCase();
        if (!apys[sym] || pool.apyBase > apys[sym]) apys[sym] = pool.apyBase;
      }
    }
    _suilendApyCache = { data: apys, ts: now };
    console.log(`[suilend/route] DefiLlama APYs: ${JSON.stringify(apys)}`);
    return apys;
  } catch (err) {
    console.error('[suilend/route] DefiLlama APY fetch failed:', err);
    return _suilendApyCache?.data ?? {};
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = searchParams.get('account');
  if (!account) return NextResponse.json({ error: 'account required' }, { status: 400 });

  try {
    console.log(`[suilend/route] Querying Obligation objects for ${account}`);

    // Step 1: get all Obligation objects (pagination loop)
    const obligations: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    let page = 0;
    do {
      page++;
      const res = await suiPost('suix_getOwnedObjects', [
        account,
        { filter: { StructType: OBLIGATION_TYPE }, options: { showContent: true, showType: true } },
        cursor,
        50,
      ]) as { data?: Array<{ data?: Record<string, unknown> }>; nextCursor?: string; hasNextPage?: boolean };

      for (const item of res?.data ?? []) {
        if (item.data) obligations.push(item.data);
      }
      cursor = res?.hasNextPage ? (res.nextCursor ?? null) : null;
    } while (cursor && page < 5);

    console.log(`[suilend/route] Found ${obligations.length} Obligation objects`);

    if (obligations.length === 0) {
      return NextResponse.json({ supplies: [], borrows: [], protocol: 'Suilend', chain: 'Sui' });
    }

    // Fetch APYs in parallel
    const apys = await getSuilendApys();

    const supplies: Array<{ symbol: string; amount: number; usdValue: number; apy: number }> = [];
    const borrows:  Array<{ symbol: string; amount: number; usdValue: number; apy: number }> = [];

    for (const obj of obligations) {
      try {
        const content = (obj as Record<string, unknown>).content as Record<string, unknown> | undefined;
        const fields  = (content?.fields as Record<string, unknown>) ?? {};
        console.log(`[suilend/route] Obligation type: ${(obj as Record<string,unknown>).type}, fields keys: ${Object.keys(fields).join(', ')}`);

        // deposits: vector<Deposit>
        const depositsRaw = (fields.deposits as unknown[]) ?? [];
        console.log(`[suilend/route] deposits count: ${depositsRaw.length}`);

        for (const dep of depositsRaw) {
          try {
            // Deposit may be wrapped: { type, fields: { coin_type, market_value, deposited_ctoken_amount, ... } }
            const df = (dep as Record<string, unknown>).fields as Record<string, unknown>
              ?? dep as Record<string, unknown>;
            const symbol   = symbolFromTypeName(df.coin_type);
            // market_value is in USD (Decimal scaled by 10^18)
            const usdValue = decodeDecimal(df.market_value);
            if (usdValue < 0.001) continue;
            const apy = apys[symbol] ?? 0;
            // amount: use ctoken amount as proxy — won't be exact without exchange rate
            // We show usdValue directly; amount set to usdValue for display consistency
            console.log(`[suilend/route] Deposit: ${symbol} $${usdValue.toFixed(4)} apy=${apy}`);
            supplies.push({ symbol, amount: usdValue, usdValue, apy });
          } catch (err) {
            console.error('[suilend/route] Deposit parse error:', err);
          }
        }

        // borrows: vector<Borrow>
        const borrowsRaw = (fields.borrows as unknown[]) ?? [];
        console.log(`[suilend/route] borrows count: ${borrowsRaw.length}`);

        for (const bor of borrowsRaw) {
          try {
            const bf = (bor as Record<string, unknown>).fields as Record<string, unknown>
              ?? bor as Record<string, unknown>;
            const symbol   = symbolFromTypeName(bf.coin_type);
            const usdValue = decodeDecimal(bf.market_value);
            if (usdValue < 0.001) continue;
            console.log(`[suilend/route] Borrow: ${symbol} $${usdValue.toFixed(4)}`);
            borrows.push({ symbol, amount: usdValue, usdValue, apy: 0 });
          } catch (err) {
            console.error('[suilend/route] Borrow parse error:', err);
          }
        }
      } catch (err) {
        console.error('[suilend/route] Obligation processing error:', err);
      }
    }

    console.log(`[suilend/route] Result: ${supplies.length} supplies, ${borrows.length} borrows`);
    return NextResponse.json({ supplies, borrows, protocol: 'Suilend', chain: 'Sui' });
  } catch (err) {
    console.error('[suilend/route] Unexpected error:', err);
    return NextResponse.json({ supplies: [], borrows: [], error: String(err) });
  }
}
