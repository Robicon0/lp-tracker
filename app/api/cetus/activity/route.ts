import { NextResponse } from 'next/server';
import { deriveDepositPrices } from '../../../lib/v3PriceDerivation';

// Cetus CLMM activity route — modeled on app/api/bluefin/activity/route.ts.
// Scans the wallet's Sui tx history, parses Cetus Move events, and returns
// the shared ActivityResponse shape consumed by useLpPnl / useWalletLevelFees.
//
// Event names + field names below are VERIFIED against live on-chain events
// (not the Cetus docs / assumptions) — the CollectFeeEvent uses amount_a /
// amount_b and the position object id is in the `position` field (NOT
// `position_id`, which is what Momentum uses).

const SUI_RPC = process.env.SUI_RPC_URL || 'https://fullnode.mainnet.sui.io:443';

// Cetus CLMM package addresses across known versions. On Sui, type identity
// is normally preserved across UPGRADES (events keep their original defining
// address — verified live: current events still carry 0x1eabed72…), but Cetus
// has shipped multiple package versions, so we match an ALLOWLIST of all known
// Cetus package addresses to stay resilient if a future version emits events
// under a new defining address.
//
// We match on PACKAGE (not event name alone) on purpose: Momentum emits
// identically-named `AddLiquidityEvent` / `RemoveLiquidityEvent`, so a
// name-only filter would wrongly capture Momentum's events as Cetus activity.
const CETUS_PKGS = [
  '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb', // original (verified live)
  '0x587614620d0d30aed66d86ffd3ba385a661a86aa573a4d579017068f561c6d8f', // v1.25.0
  '0x3b9f8d381c22bfcf7e4e6469f57a4d10d2087bbfae05248650b08fd5dff0434d', // v1.50.0
];

// Known Sui stablecoins (lowercase) — same set as the Bluefin route.
const STABLECOINS = new Set([
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::usdc',
  '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::coin', // USDT
  '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::coin', // wUSDC
]);

export type ActivityEventType = 'deposit' | 'withdrawal' | 'fee_claim' | 'reward_claim';

export interface ActivityEvent {
  type: ActivityEventType;
  txHash: string;
  timestamp: number;
  amount0: number;
  amount1: number;
  usdAtTime: number | null;
  price0AtTime: number | null;
  price1AtTime: number | null;
  cumulativeFeeUSD: number;
}

interface ActivityResponse {
  events: ActivityEvent[];
  netInvested0: number;
  netInvested1: number;
  totalFees0: number;
  totalFees1: number;
}

async function suiRpc(method: string, params: unknown[]) {
  const res = await fetch(SUI_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  return json.result;
}

async function fetchAllDigests(account: string): Promise<string[]> {
  const digests: string[] = [];
  let cursor: string | null = null;
  do {
    const result = await suiRpc('suix_queryTransactionBlocks', [
      { filter: { FromAddress: account } },
      cursor,
      50,
      true,
    ]) as { data: Array<{ digest: string }>; nextCursor?: string; hasNextPage?: boolean } | null;
    if (!result) break;
    digests.push(...result.data.map((t) => t.digest));
    cursor = result.hasNextPage ? (result.nextCursor ?? null) : null;
  } while (cursor);
  return digests;
}

interface SuiTxBlock {
  digest: string;
  timestampMs: string;
  events: Array<{ type: string; parsedJson: Record<string, unknown> }>;
}

async function fetchTransactionEvents(digests: string[]): Promise<SuiTxBlock[]> {
  const results: SuiTxBlock[] = [];
  const BATCH = 25;
  for (let i = 0; i < digests.length; i += BATCH) {
    const batch = digests.slice(i, i + BATCH);
    const txBlocks = await suiRpc('sui_multiGetTransactionBlocks', [
      batch,
      { showEvents: true, showInput: false, showEffects: false, showObjectChanges: false, showBalanceChanges: false },
    ]) as SuiTxBlock[] | null;
    if (txBlocks) results.push(...txBlocks);
  }
  return results;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const positionId = searchParams.get('positionId'); // raw Sui object ID, or "all"
  const account = searchParams.get('account') ?? '';
  const decimalsA = parseInt(searchParams.get('decimalsA') ?? '9', 10);
  const decimalsB = parseInt(searchParams.get('decimalsB') ?? '6', 10);
  const coinTypeA = searchParams.get('coinTypeA') ?? '';
  const coinTypeB = searchParams.get('coinTypeB') ?? '';
  const fallbackA = parseFloat(searchParams.get('priceA') ?? '0');
  const fallbackB = parseFloat(searchParams.get('priceB') ?? '0');
  const tickLower = searchParams.get('tickLower') != null ? parseInt(searchParams.get('tickLower')!, 10) : null;
  const tickUpper = searchParams.get('tickUpper') != null ? parseInt(searchParams.get('tickUpper')!, 10) : null;

  if (!positionId || !account) {
    return NextResponse.json({ error: 'positionId and account required' }, { status: 400 });
  }
  // Wallet-scope mode (positionId="all"): emit fee_claim events from every
  // Cetus position this wallet ever touched, including fully-closed ones
  // whose object is destroyed. Deposits/withdrawals are omitted (ambiguous
  // across pools).
  const walletScope = positionId === 'all';

  try {
    const allDigests = await fetchAllDigests(account);
    if (allDigests.length === 0) {
      return NextResponse.json({ events: [], netInvested0: 0, netInvested1: 0, totalFees0: 0, totalFees1: 0 } as ActivityResponse);
    }

    const allTxBlocks = await fetchTransactionEvents(allDigests);
    const scaleA = BigInt(10) ** BigInt(decimalsA);
    const scaleB = BigInt(10) ** BigInt(decimalsB);

    interface RawEvent {
      type: ActivityEventType;
      txHash: string;
      timestamp: number;
      amount0Raw: bigint;
      amount1Raw: bigint;
    }

    const rawEvents: RawEvent[] = [];
    let deposited0 = 0n, deposited1 = 0n;
    let withdrawn0 = 0n, withdrawn1 = 0n;
    let fees0 = 0n, fees1 = 0n;

    for (const tx of allTxBlocks) {
      if (!tx?.events) continue;
      const ts = tx.timestampMs ? Math.floor(parseInt(tx.timestampMs, 10) / 1000) : 0;

      for (const ev of tx.events) {
        if (!CETUS_PKGS.some((pkg) => ev.type.startsWith(pkg))) continue;
        const pj = ev.parsedJson ?? {};
        // Cetus position object id is in the `position` field.
        const evPosId = (pj.position as string) ?? '';
        if (!walletScope && evPosId !== positionId) continue;

        const evName = ev.type.split('::').pop() ?? '';

        // Wallet-scope: only fee events are aggregated across positions.
        if (walletScope && evName !== 'CollectFeeEvent') continue;

        if (evName === 'AddLiquidityEvent') {
          const a0 = BigInt((pj.amount_a as string) ?? '0');
          const a1 = BigInt((pj.amount_b as string) ?? '0');
          deposited0 += a0; deposited1 += a1;
          rawEvents.push({ type: 'deposit', txHash: tx.digest, timestamp: ts, amount0Raw: a0, amount1Raw: a1 });
        } else if (evName === 'RemoveLiquidityEvent') {
          const a0 = BigInt((pj.amount_a as string) ?? '0');
          const a1 = BigInt((pj.amount_b as string) ?? '0');
          withdrawn0 += a0; withdrawn1 += a1;
          rawEvents.push({ type: 'withdrawal', txHash: tx.digest, timestamp: ts, amount0Raw: a0, amount1Raw: a1 });
        } else if (evName === 'CollectFeeEvent') {
          const a0 = BigInt((pj.amount_a as string) ?? '0');
          const a1 = BigInt((pj.amount_b as string) ?? '0');
          fees0 += a0; fees1 += a1;
          rawEvents.push({ type: 'fee_claim', txHash: tx.digest, timestamp: ts, amount0Raw: a0, amount1Raw: a1 });
        }
      }
    }

    rawEvents.sort((a, b) => a.timestamp - b.timestamp);

    const hasTicks = tickLower != null && tickUpper != null;
    let runningFeeUSD = 0;
    const events: ActivityEvent[] = rawEvents.map((ev) => {
      const amount0 = Number(ev.amount0Raw) / Number(scaleA);
      const amount1 = Number(ev.amount1Raw) / Number(scaleB);

      let price0AtTime: number | null = null;
      let price1AtTime: number | null = null;
      let usdAtTime: number | null = null;

      if ((ev.type === 'deposit' || ev.type === 'withdrawal') && hasTicks && coinTypeA && coinTypeB) {
        const derived = deriveDepositPrices(
          amount0, amount1, tickLower!, tickUpper!, decimalsA, decimalsB,
          coinTypeA, coinTypeB, STABLECOINS,
        );
        if (derived) {
          price0AtTime = derived.price0;
          price1AtTime = derived.price1;
          usdAtTime = amount0 * derived.price0 + amount1 * derived.price1;
        }
      }

      if (usdAtTime == null) {
        // fee_claim, or deposit/withdrawal where derivation was unavailable:
        // value at current pool-token prices (priceA/priceB).
        price0AtTime = fallbackA || null;
        price1AtTime = fallbackB || null;
        if (fallbackA > 0 || fallbackB > 0) {
          usdAtTime = amount0 * fallbackA + amount1 * fallbackB;
        }
      }

      let cumulativeFeeUSD = 0;
      if (ev.type === 'fee_claim') {
        runningFeeUSD += usdAtTime ?? 0;
        cumulativeFeeUSD = runningFeeUSD;
      }

      return { type: ev.type, txHash: ev.txHash, timestamp: ev.timestamp, amount0, amount1, usdAtTime, price0AtTime, price1AtTime, cumulativeFeeUSD };
    });

    events.reverse(); // newest-first for display

    return NextResponse.json({
      events,
      netInvested0: Number(deposited0 - withdrawn0) / Number(scaleA),
      netInvested1: Number(deposited1 - withdrawn1) / Number(scaleB),
      totalFees0: Number(fees0) / Number(scaleA),
      totalFees1: Number(fees1) / Number(scaleB),
    } as ActivityResponse);
  } catch (err) {
    console.error('[cetus/activity] Unexpected error:', err);
    // Graceful: empty events rather than a 500 so the analytics page never
    // breaks on a Cetus RPC hiccup.
    return NextResponse.json({ events: [], netInvested0: 0, netInvested1: 0, totalFees0: 0, totalFees1: 0 } as ActivityResponse);
  }
}
