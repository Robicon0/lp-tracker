import { NextResponse } from 'next/server';

// AlphaFi / AlphaLend on Sui — raw Sui RPC
//
// Verified data model (2026-03-29):
//   AlphaLend pkg (old): 0xd631cd66138909636fc3f73ed75820d0c5b76332d1644608ed1c85ea2b8219b4
//   AlphaLend pkg (new): 0x5209a18e1ae6ac994dd5a188a2d8deb17b2bbab29f63a7b5457bdfe040f69f61
//   Lending Protocol ID: 0x01d9cf05d65fa3a9bb7163095139120e3c4e414dfbab153a49779a7d14010b93
//   Positions Table ID:  0x9923cec7b613e58cc3feec1e8651096ad7970c0b4ef28b805c7d97fe58ff91ba
//   Markets Table ID:    0x2326d387ba8bb7d24aa4cfa31f9a1e58bf9234b097574afb06c5dfb267df4c2e
//
// Position is stored as a DYNAMIC FIELD of the positions table (NOT a standalone object).
// Key type: 0x2::object::ID  Value type: position::Position
//
// Position.collaterals: VecMap<u64,u64> — market_id → ctoken_amount (raw xtokens)
// Position.loans: vector<Borrow> — { coin_type, market_id, amount (raw) }
//
// To compute USD value of collateral:
//   1. Fetch market from markets table by market_id
//   2. Get market.coin_type (TypeName) and market.xtoken_ratio (Number / 10^18)
//   3. underlying_human = ctoken_raw * xtoken_ratio / 10^token_decimals
//
// Vault Receipts (alphafi-sdk vaults):
//   Receipt pkg: 0x9bbd650b8442abb082c20f3bc95a9434a8d47b4bef98b0832dab57c1a8ba7123
//   Type: alphapool::Receipt

const SUI_RPC = process.env.SUI_RPC_URL ?? 'https://fullnode.mainnet.sui.io:443';

const ALPHALEND_PKG_OLD = '0xd631cd66138909636fc3f73ed75820d0c5b76332d1644608ed1c85ea2b8219b4';
const ALPHALEND_PKG_NEW = '0x5209a18e1ae6ac994dd5a188a2d8deb17b2bbab29f63a7b5457bdfe040f69f61';
const POSITION_CAP_OLD  = `${ALPHALEND_PKG_OLD}::position::PositionCap`;
const POSITION_CAP_NEW  = `${ALPHALEND_PKG_NEW}::position::PositionCap`;
const VAULT_RECEIPT_PKG = '0x9bbd650b8442abb082c20f3bc95a9434a8d47b4bef98b0832dab57c1a8ba7123';
const VAULT_RECEIPT_TYPE = `${VAULT_RECEIPT_PKG}::alphapool::Receipt`;

// Protocol tables (from sui_getObject on the LendingProtocol object)
const POSITIONS_TABLE = '0x9923cec7b613e58cc3feec1e8651096ad7970c0b4ef28b805c7d97fe58ff91ba';
const MARKETS_TABLE   = '0x2326d387ba8bb7d24aa4cfa31f9a1e58bf9234b097574afb06c5dfb267df4c2e';

type AssetEntry = { symbol: string; amount: number; usdValue: number; apy: number | null };

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

async function getOwnedObjects(account: string, structType: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  let page = 0;
  do {
    page++;
    const res = await suiPost('suix_getOwnedObjects', [
      account,
      { filter: { StructType: structType }, options: { showContent: true, showType: true } },
      cursor, 50,
    ]) as { data?: Array<{ data?: Record<string, unknown> }>; nextCursor?: string; hasNextPage?: boolean };
    console.log(`[alphafi/route] ${structType.split('::').pop()} page ${page}: ${res?.data?.length ?? 0} items`);
    if (page === 1) console.log(`[alphafi/route] page1 raw: ${JSON.stringify(res).slice(0, 300)}`);
    for (const item of res?.data ?? []) { if (item.data) items.push(item.data); }
    cursor = res?.hasNextPage ? (res.nextCursor ?? null) : null;
  } while (cursor && page < 5);
  return items;
}

// Decode alphafi_stdlib Number: { fields: { value: string } } / 10^18
function decodeNumber(val: unknown): number {
  if (val == null) return 0;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') return Number(val) / 1e18;
  const f = (val as Record<string, unknown>).fields as Record<string, unknown> | undefined;
  if (f?.value != null) return Number(f.value) / 1e18;
  return 0;
}

function symbolFromTypeName(coinType: unknown): string {
  if (coinType == null) return 'UNKNOWN';
  let str = typeof coinType === 'string' ? coinType
    : String(((coinType as Record<string, unknown>).fields as Record<string, unknown> | undefined)?.name ?? coinType);
  const parts = str.split('::');
  return (parts[parts.length - 1] ?? str).toUpperCase().replace('WUSDC', 'USDC');
}

// Interpolate borrow APR (in bps) from piecewise-linear interest rate curve
// kinks: utilization breakpoints [0..100], rates: APR in bps at each breakpoint
function interpolateAprBps(kinks: number[], rates: number[], utilizationPct: number): number {
  if (kinks.length === 0) return 0;
  const u = Math.max(0, Math.min(100, utilizationPct));
  for (let i = 1; i < kinks.length; i++) {
    if (u <= kinks[i]) {
      const span = kinks[i] - kinks[i - 1];
      if (span === 0) return rates[i] ?? 0;
      const t = (u - kinks[i - 1]) / span;
      return (rates[i - 1] ?? 0) + t * ((rates[i] ?? 0) - (rates[i - 1] ?? 0));
    }
  }
  return rates[rates.length - 1] ?? 0;
}

// Market data cache — includes supply APR computed from on-chain interest rate model
const _marketCache: Record<string, { symbol: string; decimals: number; xtokenRatio: number; supplyAprPct: number | null }> = {};

async function getMarketData(marketId: string): Promise<{ symbol: string; decimals: number; xtokenRatio: number; supplyAprPct: number | null } | null> {
  if (_marketCache[marketId]) return _marketCache[marketId];
  try {
    const res = await suiPost('suix_getDynamicFieldObject', [
      MARKETS_TABLE,
      { type: 'u64', value: marketId },
    ]) as { data?: { content?: { fields?: Record<string, unknown> } } };

    const mf = res?.data?.content?.fields as Record<string, unknown> | undefined;
    const val = mf?.value as Record<string, unknown> | undefined;
    const vf  = (val?.fields ?? val) as Record<string, unknown>;

    const symbol      = symbolFromTypeName(vf.coin_type);
    const xtokenRatio = decodeNumber(vf.xtoken_ratio);
    // decimal_digit is Number type = 10^token_decimals (e.g. 10^6 for USDC)
    const decimalDigit = decodeNumber(vf.decimal_digit);
    const decimals = decimalDigit > 0 ? Math.round(Math.log10(decimalDigit)) : 6;

    // ── Supply APR from on-chain interest rate model ──────────────────────────
    let supplyAprPct: number | null = null;
    try {
      const balanceHolding = Number(vf.balance_holding ?? '0');
      const borrowedAmount = Number(vf.borrowed_amount ?? '0');
      const total = balanceHolding + borrowedAmount;
      const utilizationPct = total > 0 ? (borrowedAmount / total) * 100 : 0;

      const cfg = (vf.config as Record<string, unknown>)?.fields as Record<string, unknown> | undefined;
      const kinks = Array.isArray(cfg?.interest_rate_kinks)
        ? (cfg.interest_rate_kinks as unknown[]).map(Number)
        : [];
      const rates = Array.isArray(cfg?.interest_rates)
        ? (cfg.interest_rates as unknown[]).map(Number)
        : [];
      const spreadFeeBps = Number(cfg?.spread_fee_bps ?? 0);

      if (kinks.length > 0 && rates.length > 0) {
        const borrowAprBps = interpolateAprBps(kinks, rates, utilizationPct);
        // supply_APR = borrow_APR × utilization × (1 - spread_fee)
        supplyAprPct = (borrowAprBps / 100) * (utilizationPct / 100) * (1 - spreadFeeBps / 10000);
        console.log(`[alphafi/route] Market ${marketId} (${symbol}): util=${utilizationPct.toFixed(1)}% borrowApr=${(borrowAprBps/100).toFixed(2)}% supplyApr=${supplyAprPct.toFixed(4)}%`);
      }
    } catch (aprErr) {
      console.error(`[alphafi/route] Market ${marketId} APR calc failed:`, aprErr);
    }

    const data = { symbol, decimals, xtokenRatio, supplyAprPct };
    _marketCache[marketId] = data;
    return data;
  } catch (err) {
    console.error(`[alphafi/route] Market ${marketId} fetch failed:`, err);
    return null;
  }
}

const STABLE: Record<string, number> = { USDC: 1, USDT: 1, DAI: 1, WUSDC: 1 };
const CG_IDS: Record<string, string> = {
  SUI: 'sui', STSUI: 'sui', WETH: 'ethereum', ETH: 'ethereum',
  BTC: 'bitcoin', WBTC: 'bitcoin', DEEP: 'deep', BLUE: 'blue-move',
};

const _priceCache: Record<string, { price: number; ts: number }> = {};
async function getPriceUsd(symbol: string): Promise<number> {
  const s = symbol.toUpperCase();
  if (STABLE[s] !== undefined) return STABLE[s];
  const id = CG_IDS[s];
  if (!id) { console.log(`[alphafi/route] No CoinGecko ID for ${s}`); return 0; }
  const cached = _priceCache[id];
  if (cached && Date.now() - cached.ts < 60_000) return cached.price;
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`)
      .then(res => res.json()) as Record<string, { usd?: number }>;
    const price = r[id]?.usd ?? 0;
    _priceCache[id] = { price, ts: Date.now() };
    return price;
  } catch (err) {
    console.error(`[alphafi/route] CoinGecko failed for ${s}:`, err);
    return cached?.price ?? 0;
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = searchParams.get('account');
  if (!account) return NextResponse.json({ error: 'account required' }, { status: 400 });

  console.log(`[alphafi/route] Starting fetch for account: ${account}`);

  const supplies: AssetEntry[] = [];
  const borrows:  AssetEntry[] = [];

  // ── AlphaLend positions ─────────────────────────────────────────────────────
  await (async () => {
    const [capsOld, capsNew] = await Promise.all([
      getOwnedObjects(account, POSITION_CAP_OLD),
      getOwnedObjects(account, POSITION_CAP_NEW),
    ]);
    const caps = [...capsOld, ...capsNew];
    console.log(`[alphafi/route] PositionCap total: ${caps.length} (old=${capsOld.length}, new=${capsNew.length})`);
    if (caps.length === 0) {
      console.log(`[alphafi/route] No AlphaLend PositionCap found for address: ${account}`);
      return;
    }

    for (const cap of caps) {
      try {
        const capFields = ((cap as Record<string, unknown>).content as Record<string, unknown>)?.fields as Record<string, unknown> ?? {};
        console.log(`[alphafi/route] PositionCap fields: ${JSON.stringify(capFields).slice(0, 300)}`);

        const posRef = capFields.position_id as string | Record<string, string> | undefined;
        const posId  = typeof posRef === 'string' ? posRef : posRef?.id ?? null;
        if (!posId) { console.warn('[alphafi/route] No position_id in cap'); continue; }

        console.log(`[alphafi/route] Fetching position from table. posId: ${posId}`);

        // Position lives as a dynamic field in POSITIONS_TABLE keyed by 0x2::object::ID
        const dynRes = await suiPost('suix_getDynamicFieldObject', [
          POSITIONS_TABLE,
          { type: '0x2::object::ID', value: posId },
        ]) as { data?: { content?: { fields?: Record<string, unknown> } } };

        const dynFields = dynRes?.data?.content?.fields as Record<string, unknown> | undefined;
        console.log(`[alphafi/route] Dynamic field keys: ${Object.keys(dynFields ?? {}).join(', ')}`);

        // value field contains the Position struct
        const posData = dynFields?.value as Record<string, unknown> | undefined;
        const posFields = ((posData as Record<string, unknown>)?.fields ?? posData) as Record<string, unknown>;
        console.log(`[alphafi/route] Position fields keys: ${Object.keys(posFields).join(', ')}`);
        console.log(`[alphafi/route] Position raw: ${JSON.stringify(posFields).slice(0, 600)}`);

        // collaterals: VecMap<u64,u64> — market_id → ctoken_amount
        const collaterals = posFields.collaterals as Record<string, unknown> | undefined;
        const colFields   = (collaterals as Record<string, unknown>)?.fields as Record<string, unknown> | undefined;
        const contents    = (colFields?.contents as unknown[]) ?? [];
        console.log(`[alphafi/route] Collateral entries: ${contents.length}`);

        for (const entry of contents) {
          try {
            const ef  = (entry as Record<string, unknown>).fields as Record<string, unknown> ?? entry as Record<string, unknown>;
            const marketId = String(ef.key ?? ef.market_id ?? '');
            const ctokenRaw = Number(ef.value ?? 0);
            if (!marketId || ctokenRaw === 0) continue;

            const market = await getMarketData(marketId);
            if (!market) continue;

            // underlying_human = ctokenRaw * xtokenRatio / 10^decimals
            const underlyingHuman = (ctokenRaw * market.xtokenRatio) / Math.pow(10, market.decimals);
            const price    = await getPriceUsd(market.symbol);
            const usdValue = underlyingHuman * price;
            const apy = market.supplyAprPct;
            console.log(`[alphafi/route] Supply: ${market.symbol} ctokenRaw=${ctokenRaw} underlying=${underlyingHuman.toFixed(4)} usd=${usdValue.toFixed(2)} apy=${apy?.toFixed(4) ?? 'null'}%`);
            if (usdValue > 0.01 || underlyingHuman > 0.000001) {
              supplies.push({ symbol: market.symbol, amount: underlyingHuman, usdValue, apy });
            }
          } catch (err) {
            console.error('[alphafi/route] Collateral entry error:', err);
          }
        }

        // loans: vector<Borrow> — each: { coin_type, market_id, amount }
        const loansRaw = (posFields.loans as unknown[]) ?? [];
        console.log(`[alphafi/route] Loan entries: ${loansRaw.length}`);
        for (const loan of loansRaw) {
          try {
            const lf = (loan as Record<string, unknown>).fields as Record<string, unknown>
              ?? loan as Record<string, unknown>;
            const symbol   = symbolFromTypeName(lf.coin_type);
            const marketId = String(lf.market_id ?? '');
            const rawAmt   = Number(lf.amount ?? 0);
            const market   = marketId ? await getMarketData(marketId) : null;
            const decimals = market?.decimals ?? (symbol === 'SUI' ? 9 : 6);
            const amount   = rawAmt / Math.pow(10, decimals);
            if (amount < 0.000001) continue;
            const price    = await getPriceUsd(symbol);
            console.log(`[alphafi/route] Borrow: ${symbol} amount=${amount} usd=${(amount*price).toFixed(2)}`);
            borrows.push({ symbol, amount, usdValue: amount * price, apy: 0 });
          } catch (err) { console.error('[alphafi/route] Loan error:', err); }
        }
      } catch (err) {
        console.error('[alphafi/route] PositionCap processing error:', err);
      }
    }
  })();

  // ── AlphaFi Vault receipts ──────────────────────────────────────────────────
  await (async () => {
    const receipts = await getOwnedObjects(account, VAULT_RECEIPT_TYPE);
    console.log(`[alphafi/route] Vault receipts: ${receipts.length}`);
    if (receipts.length === 0) {
      console.log(`[alphafi/route] No AlphaFi vault receipts for address: ${account}`);
      return;
    }
    for (const receipt of receipts) {
      try {
        const rf = ((receipt as Record<string, unknown>).content as Record<string, unknown>)?.fields as Record<string, unknown> ?? {};
        console.log(`[alphafi/route] Receipt fields: ${JSON.stringify(rf).slice(0, 400)}`);
        const poolId = typeof rf.pool_id === 'string' ? rf.pool_id
          : (rf.pool_id as Record<string, string> | undefined)?.id ?? null;
        const shares = Number(rf.amount ?? rf.shares ?? rf.balance ?? 0);
        if (!poolId || shares === 0) continue;

        const poolObj = await suiPost('sui_getObject', [poolId, { showContent: true, showType: true }]) as {
          data?: { content?: { fields?: Record<string, unknown> }; type?: string };
        };
        const poolType   = poolObj?.data?.type ?? '';
        const poolFields = poolObj?.data?.content?.fields ?? {};
        console.log(`[alphafi/route] Pool type: ${poolType}, fields: ${Object.keys(poolFields).join(', ')}`);
        console.log(`[alphafi/route] Pool raw: ${JSON.stringify(poolFields).slice(0, 400)}`);

        const totalSupply = Number(poolFields.total_supply ?? poolFields.xtoken_supply ?? 0);
        const tvlRaw = decodeNumber(poolFields.tvl ?? poolFields.total_value ?? null);
        const match  = poolType.match(/<([^,>]+)(?:,|>)/);
        const symbol = match ? symbolFromTypeName(match[1]) : 'Vault';

        if (tvlRaw > 0 && totalSupply > 0) {
          const usdValue = (shares / totalSupply) * tvlRaw;
          console.log(`[alphafi/route] Vault ${symbol}: shares=${shares} tvl=${tvlRaw} usd=${usdValue.toFixed(2)}`);
          if (usdValue > 0.01) supplies.push({ symbol, amount: shares, usdValue, apy: 0 });
        } else {
          console.log(`[alphafi/route] Vault ${symbol}: cannot compute USD. tvl=${tvlRaw} supply=${totalSupply}`);
        }
      } catch (err) { console.error('[alphafi/route] Receipt error:', err); }
    }
  })();

  console.log(`[alphafi/route] Final: ${supplies.length} supplies, ${borrows.length} borrows`);
  return NextResponse.json({ supplies, borrows, protocol: 'AlphaFi', chain: 'Sui' });
}
