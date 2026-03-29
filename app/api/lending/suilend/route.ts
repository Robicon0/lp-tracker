import { NextResponse } from 'next/server';

// Suilend on Sui — raw Sui RPC (no SDK)
//
// Verified from suilend/suilend-public SDK source (2026-03-29):
//   Package:            0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf
//   MAIN_POOL type arg: 0xf95b...::suilend::MAIN_POOL
//   Lending Market ID:  0x84030d26d85eaa7035084a057f2f11f701b7e2e4eda87551becbc7c97505ece1
//
// User position flow:
//   1. User wallet owns ObligationOwnerCap<MAIN_POOL> objects (NOT Obligation directly)
//   2. Cap fields: { id, obligation_id }
//   3. Fetch Obligation by obligation_id via sui_getObject
//   4. Obligation.deposits: vector<Deposit>  — { coin_type, deposited_ctoken_amount, market_value (Decimal) }
//   5. Obligation.borrows:  vector<Borrow>   — { coin_type, borrowed_amount (Decimal), market_value (Decimal) }
//   Decimal type: { fields: { value: string } } scaled by 10^18

const SUI_RPC = process.env.SUI_RPC_URL ?? 'https://fullnode.mainnet.sui.io:443';

const SUILEND_PKG  = '0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf';
const MAIN_POOL    = `${SUILEND_PKG}::suilend::MAIN_POOL`;
const OBLIG_CAP_TYPE = `${SUILEND_PKG}::lending_market::ObligationOwnerCap<${MAIN_POOL}>`;

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

// Decode Suilend Decimal type: { fields: { value: "123..." } } / 10^18
function decodeDecimal(val: unknown): number {
  if (val == null) return 0;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const n = Number(val);
    // If the raw string is a large integer it's likely 10^18 scaled
    return val.length > 10 ? n / 1e18 : n;
  }
  const fields = (val as Record<string, unknown>).fields as Record<string, unknown> | undefined;
  if (fields?.value != null) {
    const n = Number(fields.value);
    return n / 1e18;
  }
  return 0;
}

// Extract symbol from Sui TypeName struct or coin type string
function symbolFromTypeName(coinType: unknown): string {
  if (coinType == null) return 'UNKNOWN';
  let str = '';
  if (typeof coinType === 'string') {
    str = coinType;
  } else {
    // TypeName struct: { fields: { name: "0x2::sui::SUI" } }
    const f = (coinType as Record<string, unknown>).fields as Record<string, unknown> | undefined;
    str = String(f?.name ?? coinType);
  }
  const parts = str.split('::');
  return (parts[parts.length - 1] ?? str).toUpperCase();
}

// Token prices for converting USD value → token amount
const STABLE_PRICE: Record<string, number> = {
  USDC: 1, USDT: 1, DAI: 1, BUCK: 1, USDY: 1, FDUSD: 1,
};
const CG_IDS: Record<string, string> = {
  SUI: 'sui', SPRING_SUI: 'sui', STSUI: 'sui', SSUI: 'sui',
  WETH: 'ethereum', ETH: 'ethereum', WBTC: 'bitcoin', BTC: 'bitcoin',
  DEEP: 'deepbook', CETUS: 'cetus-protocol', NS: 'name-service-sui',
  NAVX: 'navi-protocol', BLUE: 'blue-sui',
};
const _priceCache: Record<string, { price: number; ts: number }> = {};
async function getPriceUsd(symbol: string): Promise<number> {
  const s = symbol.toUpperCase();
  if (STABLE_PRICE[s] !== undefined) return STABLE_PRICE[s];
  const id = CG_IDS[s];
  if (!id) return 0;
  const cached = _priceCache[id];
  if (cached && Date.now() - cached.ts < 60_000) return cached.price;
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`)
      .then(res => res.json()) as Record<string, { usd?: number }>;
    const price = r[id]?.usd ?? 0;
    _priceCache[id] = { price, ts: Date.now() };
    return price;
  } catch { return cached?.price ?? 0; }
}

// DefiLlama APY cache for Suilend
let _apyCache: { data: Record<string, number>; ts: number } | null = null;
async function getSuilendApys(): Promise<Record<string, number>> {
  const now = Date.now();
  if (_apyCache && now - _apyCache.ts < 300_000) return _apyCache.data;
  try {
    const res = await fetch('https://yields.llama.fi/pools').then(r => r.json()) as {
      data?: Array<{ project: string; chain: string; symbol: string; apyBase: number | null }>;
    };
    const apys: Record<string, number> = {};
    for (const pool of res?.data ?? []) {
      if (pool.project?.toLowerCase().includes('suilend') && pool.chain === 'Sui' && pool.apyBase != null) {
        const sym = pool.symbol.split('-')[0].trim().toUpperCase();
        if (!apys[sym] || pool.apyBase > apys[sym]) apys[sym] = pool.apyBase;
      }
    }
    _apyCache = { data: apys, ts: now };
    console.log(`[suilend/route] DefiLlama APYs loaded: ${JSON.stringify(apys)}`);
    return apys;
  } catch (err) {
    console.error('[suilend/route] DefiLlama APY fetch failed:', err);
    return _apyCache?.data ?? {};
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = searchParams.get('account');
  if (!account) return NextResponse.json({ error: 'account required' }, { status: 400 });

  try {
    console.log(`[suilend/route] Querying ObligationOwnerCap for account: ${account}`);
    console.log(`[suilend/route] StructType filter: ${OBLIG_CAP_TYPE}`);

    // Step 1: find all ObligationOwnerCap objects owned by the user
    const caps: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    let page = 0;
    do {
      page++;
      const res = await suiPost('suix_getOwnedObjects', [
        account,
        { filter: { StructType: OBLIG_CAP_TYPE }, options: { showContent: true, showType: true } },
        cursor,
        50,
      ]) as { data?: Array<{ data?: Record<string, unknown> }>; nextCursor?: string; hasNextPage?: boolean };

      console.log(`[suilend/route] Page ${page} raw result: ${JSON.stringify(res).slice(0, 400)}`);

      for (const item of res?.data ?? []) {
        if (item.data) caps.push(item.data);
      }
      cursor = res?.hasNextPage ? (res.nextCursor ?? null) : null;
    } while (cursor && page < 5);

    if (caps.length === 0) {
      console.log(`[suilend/route] No ObligationOwnerCap objects found for address: ${account}`);
      return NextResponse.json({ supplies: [], borrows: [], protocol: 'Suilend', chain: 'Sui' });
    }

    console.log(`[suilend/route] Found ${caps.length} ObligationOwnerCap object(s)`);

    const apys = await getSuilendApys();
    const supplies: Array<{ symbol: string; amount: number; usdValue: number; apy: number }> = [];
    const borrows:  Array<{ symbol: string; amount: number; usdValue: number; apy: number }> = [];

    for (const cap of caps) {
      try {
        const content = (cap as Record<string, unknown>).content as Record<string, unknown> | undefined;
        const capFields = (content?.fields ?? {}) as Record<string, unknown>;
        console.log(`[suilend/route] Cap fields: ${JSON.stringify(capFields).slice(0, 400)}`);

        // obligation_id is an ID struct: { id: "0x..." } or plain string
        const obligRef = capFields.obligation_id as string | Record<string, string> | undefined;
        const obligId = typeof obligRef === 'string' ? obligRef : obligRef?.id ?? null;

        if (!obligId) {
          console.warn(`[suilend/route] Cap missing obligation_id. All fields: ${JSON.stringify(capFields)}`);
          continue;
        }

        console.log(`[suilend/route] Fetching Obligation object: ${obligId}`);
        const obligObj = await suiPost('sui_getObject', [
          obligId,
          { showContent: true, showType: true },
        ]) as { data?: { content?: { fields?: Record<string, unknown> }; type?: string } };

        console.log(`[suilend/route] Obligation type: ${obligObj?.data?.type}`);
        const obligFields = obligObj?.data?.content?.fields ?? {};
        console.log(`[suilend/route] Obligation fields keys: ${Object.keys(obligFields).join(', ')}`);
        console.log(`[suilend/route] Obligation raw (first 800): ${JSON.stringify(obligFields).slice(0, 800)}`);

        // deposits: vector<Deposit>
        const depositsRaw = (obligFields.deposits as unknown[]) ?? [];
        console.log(`[suilend/route] deposits count: ${depositsRaw.length}`);

        for (const dep of depositsRaw) {
          try {
            // Each Deposit may be: { type: "...", fields: { coin_type, market_value, ... } }
            const df = (dep as Record<string, unknown>).fields as Record<string, unknown>
              ?? dep as Record<string, unknown>;
            console.log(`[suilend/route] Deposit raw fields: ${JSON.stringify(df).slice(0, 300)}`);

            const symbol   = symbolFromTypeName(df.coin_type);
            const usdValue = decodeDecimal(df.market_value);

            if (usdValue < 0.001) {
              console.log(`[suilend/route] Skipping deposit ${symbol}: usdValue=${usdValue} (too small)`);
              continue;
            }

            const apy    = apys[symbol] ?? apys[symbol.replace('W', '')] ?? 0;
            const price  = await getPriceUsd(symbol);
            const amount = price > 0 ? usdValue / price : usdValue;
            console.log(`[suilend/route] Deposit: ${symbol} usd=$${usdValue.toFixed(4)} amount=${amount.toFixed(4)} apy=${apy}`);
            supplies.push({ symbol, amount, usdValue, apy });
          } catch (err) {
            console.error('[suilend/route] Deposit parse error:', err, JSON.stringify(dep).slice(0, 200));
          }
        }

        // borrows: vector<Borrow>
        const borrowsRaw = (obligFields.borrows as unknown[]) ?? [];
        console.log(`[suilend/route] borrows count: ${borrowsRaw.length}`);

        for (const bor of borrowsRaw) {
          try {
            const bf = (bor as Record<string, unknown>).fields as Record<string, unknown>
              ?? bor as Record<string, unknown>;
            const symbol   = symbolFromTypeName(bf.coin_type);
            const usdValue = decodeDecimal(bf.market_value);

            if (usdValue < 0.001) continue;
            const bPrice  = await getPriceUsd(symbol);
            const bAmount = bPrice > 0 ? usdValue / bPrice : usdValue;
            console.log(`[suilend/route] Borrow: ${symbol} usd=$${usdValue.toFixed(4)} amount=${bAmount.toFixed(4)}`);
            borrows.push({ symbol, amount: bAmount, usdValue, apy: 0 });
          } catch (err) {
            console.error('[suilend/route] Borrow parse error:', err);
          }
        }
      } catch (err) {
        console.error('[suilend/route] Obligation processing error:', err);
      }
    }

    console.log(`[suilend/route] Final: ${supplies.length} supplies, ${borrows.length} borrows`);
    return NextResponse.json({ supplies, borrows, protocol: 'Suilend', chain: 'Sui' });
  } catch (err) {
    console.error('[suilend/route] Unexpected error:', err);
    return NextResponse.json({ supplies: [], borrows: [], error: String(err) });
  }
}
