import { NextResponse } from 'next/server';

// Suilend on Sui — raw Sui RPC (no SDK)
//
// Data model:
//   1. User owns ObligationOwnerCap<MAIN_POOL> → cap.fields.obligation_id
//   2. Fetch Obligation → deposits[] + borrows[]
//   3. Each deposit has reserve_array_index + deposited_ctoken_amount (u64)
//   4. Fetch LendingMarket → reserves[]; each reserve has exchange rate data
//   5. exchange_rate = (available + borrowed_base - spread_base) / ctoken_supply (all base units)
//   6. underlying = deposited_ctoken_amount * exchange_rate / 10^decimals
//   7. For borrows: current = obligation_borrow.borrowed_amount * reserve_cbr / obligation_cbr
//
// Decimal type: { fields: { value: string } } where value = amount_in_base_units * 10^18

const SUI_RPC = process.env.SUI_RPC_URL ?? 'https://fullnode.mainnet.sui.io:443';

const SUILEND_PKG     = '0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf';
const MAIN_POOL       = `${SUILEND_PKG}::suilend::MAIN_POOL`;
const OBLIG_CAP_TYPE  = `${SUILEND_PKG}::lending_market::ObligationOwnerCap<${MAIN_POOL}>`;
const LENDING_MARKET  = '0x84030d26d85eaa7035084a057f2f11f701b7e2e4eda87551becbc7c97505ece1';

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

// Extract symbol from Sui TypeName struct or plain string
function symbolFromTypeName(coinType: unknown): string {
  if (coinType == null) return 'UNKNOWN';
  let str = typeof coinType === 'string' ? coinType
    : String(((coinType as Record<string, unknown>).fields as Record<string, unknown> | undefined)?.name ?? coinType);
  const parts = str.split('::');
  return (parts[parts.length - 1] ?? str).toUpperCase();
}

// Extract raw bigint from a Suilend Decimal: { fields: { value: "..." } }
function decimalRaw(val: unknown): bigint {
  if (val == null) return 0n;
  if (typeof val === 'string') return BigInt(val);
  const f = (val as Record<string, unknown>).fields as Record<string, unknown> | undefined;
  return f?.value != null ? BigInt(String(f.value)) : 0n;
}

// Compute underlying token amount from ctokens using reserve exchange rate (all BigInt, no precision loss)
//   exchange_rate = (available_base + borrow_decimal/WAD - spread_decimal/WAD) / ctoken_supply_base
//   underlying_base = deposited_ctokens * numerator / ctoken_supply
//   underlying_human = underlying_base / 10^decimals
function computeUnderlyingHuman(
  depositedCtokens: bigint,
  availableRaw: bigint,
  borrowedDecimal: bigint,
  spreadDecimal: bigint,
  ctokenSupply: bigint,
  decimals: number,
): number {
  if (ctokenSupply === 0n) return 0;
  const WAD = 10n ** 18n;
  const borrowBase = borrowedDecimal / WAD;
  const spreadBase = spreadDecimal / WAD;
  const totalBase = availableRaw + borrowBase - spreadBase;
  const underlyingBase = depositedCtokens * totalBase / ctokenSupply;
  return Number(underlyingBase) / Math.pow(10, decimals);
}

// Compute current borrow with interest: obligation_amount * reserve_cbr / obligation_cbr
function computeCurrentBorrowHuman(
  obBorrowedDecimal: bigint,
  obCbrDecimal: bigint,
  reserveCbrDecimal: bigint,
  decimals: number,
): number {
  if (obCbrDecimal === 0n) return 0;
  const WAD = 10n ** 18n;
  const currentVal = obBorrowedDecimal * reserveCbrDecimal / obCbrDecimal;
  const borrowBase = currentVal / WAD;
  return Number(borrowBase) / Math.pow(10, decimals);
}

// Token price via CoinGecko (stable coins short-circuited)
const STABLE_PRICE: Record<string, number> = {
  USDC: 1, USDT: 1, DAI: 1, BUCK: 1, USDY: 1, FDUSD: 1,
};
const CG_IDS: Record<string, string> = {
  SUI: 'sui', SPRING_SUI: 'sui', STSUI: 'sui', SSUI: 'sui',
  WETH: 'ethereum', ETH: 'ethereum', WBTC: 'bitcoin', BTC: 'bitcoin',
  DEEP: 'deep', CETUS: 'cetus-protocol', NS: 'name-service-sui',
  NAVX: 'navi-protocol', BLUE: 'blue-move',
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

// Interpolate APR from piecewise-linear interest rate curve
// utils: utilization breakpoints [0..100], aprs: APR in bps at each breakpoint
function interpolateAprBps(utils: number[], aprsBps: number[], utilizationPct: number): number {
  if (utils.length === 0) return 0;
  const u = Math.max(0, Math.min(100, utilizationPct));
  for (let i = 1; i < utils.length; i++) {
    if (u <= utils[i]) {
      const t = (u - utils[i - 1]) / (utils[i] - utils[i - 1]);
      return aprsBps[i - 1] + t * (aprsBps[i] - aprsBps[i - 1]);
    }
  }
  return aprsBps[aprsBps.length - 1] ?? 0;
}

// Reserve data extracted from LendingMarket object
interface ReserveInfo {
  arrayIndex: number;
  symbol: string;
  decimals: number;
  availableRaw: bigint;        // u64 base units
  borrowedDecimalRaw: bigint;  // Decimal.value (base * WAD)
  spreadDecimalRaw: bigint;    // Decimal.value
  ctokenSupplyRaw: bigint;     // u64 base units
  cbrDecimalRaw: bigint;       // cumulative_borrow_rate Decimal.value
  supplyAprPct: number | null; // null when config missing or calculation failed
  oraclePriceUsd: number;      // real-time Pyth oracle price (fallback for CoinGecko failures)
}

// Reserve cache — refresh every 30s
let _reserveCache: { data: Map<number, ReserveInfo>; ts: number } | null = null;

async function loadReserves(): Promise<Map<number, ReserveInfo>> {
  const now = Date.now();
  if (_reserveCache && now - _reserveCache.ts < 30_000) return _reserveCache.data;

  const obj = await suiPost('sui_getObject', [LENDING_MARKET, { showContent: true }]) as {
    data?: { content?: { fields?: Record<string, unknown> } };
  };
  const lmFields = obj?.data?.content?.fields ?? {};
  const reservesRaw = (lmFields.reserves as unknown[]) ?? [];

  const map = new Map<number, ReserveInfo>();
  for (const r of reservesRaw) {
    try {
      const rf = (r as Record<string, unknown>).fields as Record<string, unknown> ?? r as Record<string, unknown>;
      const arrayIndex = Number(rf.array_index ?? 0);

      const availableRaw = BigInt(String(rf.available_amount ?? '0'));
      const borrowedDecimalRaw = decimalRaw(rf.borrowed_amount);
      const spreadDecimalRaw = decimalRaw(rf.unclaimed_spread_fees);
      const ctokenSupplyRaw = BigInt(String(rf.ctoken_supply ?? '0'));

      // Compute supply APR from on-chain interest rate curve
      const WAD = 10n ** 18n;
      const borrowBase = borrowedDecimalRaw / WAD;
      const totalBase = availableRaw + borrowBase;
      const utilizationPct = totalBase > 0n
        ? Number(borrowBase * 10000n / totalBase) / 100
        : 0;

      // Extract interest rate config: config.fields.element.fields
      const configEl = (rf.config as Record<string, unknown>)
        ?.fields as Record<string, unknown> | undefined;
      const configInner = (configEl?.element as Record<string, unknown>)
        ?.fields as Record<string, unknown> | undefined;
      const irUtils = (configInner?.interest_rate_utils as number[]) ?? [];
      const irAprsBps = (configInner?.interest_rate_aprs as string[])?.map(Number) ?? [];
      const spreadFeeBps = Number(configInner?.spread_fee_bps ?? 0);

      const borrowAprBps = interpolateAprBps(irUtils, irAprsBps, utilizationPct);
      const rawApr = (borrowAprBps / 100) * (utilizationPct / 100) * (1 - spreadFeeBps / 10000);
      const supplyAprPct: number | null = (irUtils.length === 0 || irAprsBps.length === 0 || isNaN(rawApr) || !isFinite(rawApr)) ? null : rawApr;
      if (map.size < 3) {
        console.log(`[suilend/route] Reserve ${arrayIndex}: util=${utilizationPct.toFixed(1)}% irUtils=${JSON.stringify(irUtils)} irAprsBps=${JSON.stringify(irAprsBps)} spread=${spreadFeeBps} → supplyApr=${supplyAprPct?.toFixed(4) ?? 'null'}%`);
      }

      const oraclePriceUsd = Number(decimalRaw(rf.price)) / 1e18;

      map.set(arrayIndex, {
        arrayIndex,
        symbol: symbolFromTypeName(rf.coin_type),
        decimals: Number(rf.mint_decimals ?? 9),
        availableRaw,
        borrowedDecimalRaw,
        spreadDecimalRaw,
        ctokenSupplyRaw,
        cbrDecimalRaw: decimalRaw(rf.cumulative_borrow_rate),
        supplyAprPct,
        oraclePriceUsd,
      });
    } catch (e) {
      console.error('[suilend/route] Reserve parse error:', e);
    }
  }
  _reserveCache = { data: map, ts: now };
  console.log(`[suilend/route] Loaded ${map.size} reserves from LendingMarket`);
  return map;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = searchParams.get('account');
  if (!account) return NextResponse.json({ error: 'account required' }, { status: 400 });

  try {
    // Step 1: find ObligationOwnerCap objects
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
      for (const item of res?.data ?? []) {
        if (item.data) caps.push(item.data);
      }
      cursor = res?.hasNextPage ? (res.nextCursor ?? null) : null;
    } while (cursor && page < 5);

    if (caps.length === 0) {
      return NextResponse.json({ supplies: [], borrows: [], protocol: 'Suilend', chain: 'Sui' });
    }
    console.log(`[suilend/route] Found ${caps.length} ObligationOwnerCap for ${account}`);

    // Step 2: load reserves (supply APR is computed on-chain inside loadReserves)
    const reserves = await loadReserves();

    const supplies: Array<{ symbol: string; amount: number; usdValue: number; apy: number | null }> = [];
    const borrows:  Array<{ symbol: string; amount: number; usdValue: number; apy: number | null }> = [];

    for (const cap of caps) {
      try {
        const content = (cap as Record<string, unknown>).content as Record<string, unknown> | undefined;
        const capFields = (content?.fields ?? {}) as Record<string, unknown>;
        const obligRef = capFields.obligation_id as string | Record<string, string> | undefined;
        const obligId = typeof obligRef === 'string' ? obligRef : obligRef?.id ?? null;
        if (!obligId) continue;

        const obligObj = await suiPost('sui_getObject', [obligId, { showContent: true }]) as {
          data?: { content?: { fields?: Record<string, unknown> } };
        };
        const obligFields = obligObj?.data?.content?.fields ?? {};

        // ── Deposits ────────────────────────────────────────────────────────────
        for (const dep of (obligFields.deposits as unknown[]) ?? []) {
          try {
            const df = (dep as Record<string, unknown>).fields as Record<string, unknown>
              ?? dep as Record<string, unknown>;
            const reserveIdx = Number(df.reserve_array_index ?? -1);
            const reserve = reserves.get(reserveIdx);
            if (!reserve) {
              console.warn(`[suilend/route] Deposit: reserve ${reserveIdx} not found`);
              continue;
            }

            const ctokens = BigInt(String(df.deposited_ctoken_amount ?? '0'));
            const underlying = computeUnderlyingHuman(
              ctokens,
              reserve.availableRaw,
              reserve.borrowedDecimalRaw,
              reserve.spreadDecimalRaw,
              reserve.ctokenSupplyRaw,
              reserve.decimals,
            );
            if (underlying < 0.0001) continue;

            const symbol = reserve.symbol;
            const cgPrice = await getPriceUsd(symbol);
            // Fall back to on-chain Pyth oracle price if CoinGecko is unavailable
            const price = cgPrice > 0 ? cgPrice : reserve.oraclePriceUsd;
            const usdValue = underlying * price;
            if (usdValue < 0.001) continue;

            const apy = reserve.supplyAprPct;
            console.log(`[suilend/route] Deposit: ${symbol} amount=${underlying.toFixed(4)} usd=$${usdValue.toFixed(2)} apy=${apy?.toFixed(4) ?? 'null'}%`);
            supplies.push({ symbol, amount: underlying, usdValue, apy });
          } catch (err) {
            console.error('[suilend/route] Deposit parse error:', err);
          }
        }

        // ── Borrows ─────────────────────────────────────────────────────────────
        for (const bor of (obligFields.borrows as unknown[]) ?? []) {
          try {
            const bf = (bor as Record<string, unknown>).fields as Record<string, unknown>
              ?? bor as Record<string, unknown>;
            const reserveIdx = Number(bf.reserve_array_index ?? -1);
            const reserve = reserves.get(reserveIdx);
            if (!reserve) continue;

            const obBorrowedVal = decimalRaw(bf.borrowed_amount);
            const obCbrVal      = decimalRaw(bf.cumulative_borrow_rate);

            const amount = computeCurrentBorrowHuman(
              obBorrowedVal,
              obCbrVal,
              reserve.cbrDecimalRaw,
              reserve.decimals,
            );
            if (amount < 0.0001) continue;

            const symbol = reserve.symbol;
            const cgPrice = await getPriceUsd(symbol);
            const price = cgPrice > 0 ? cgPrice : reserve.oraclePriceUsd;
            const usdValue = amount * price;
            if (usdValue < 0.001) continue;

            console.log(`[suilend/route] Borrow: ${symbol} amount=${amount.toFixed(4)} usd=$${usdValue.toFixed(2)}`);
            borrows.push({ symbol, amount, usdValue, apy: 0 });
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
