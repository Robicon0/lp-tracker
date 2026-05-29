import { NextResponse } from 'next/server';

// Cetus CLMM activity route.
//
// IMPLEMENTATION NOTE — why NOT the @cetusprotocol/cetus-sui-clmm-sdk:
// That SDK is a transaction-BUILDING / current-state-READING toolkit (Pool,
// Position, Swap, Rewarder modules — getPosition / getPositionList read the
// CURRENT position object). It has NO position-transaction-history method;
// historical activity comes from Cetus's off-chain indexer API or directly
// from chain events. So per the task's CRITICAL fallback we query on-chain
// events via `suix_queryEvents` (event-indexed, fewer round-trips and smaller
// payloads than scanning every tx via suix_queryTransactionBlocks — which is
// what previously MISSED deposits).
//
// ROOT CAUSE of the missing deposits (verified live on-chain): Cetus emits its
// liquidity events as `pool::AddLiquidityV2Event` / `pool::RemoveLiquidityV2Event`
// from a SEPARATE newer package `0xdb5cd62a…`, NOT `AddLiquidityEvent` from the
// original `0x1eabed72…`. The old filter looked for the wrong name AND wrong
// package, so deposits/withdrawals were never found. Fees still come from
// `0x1eabed72…::pool::CollectFeeEvent`. Both packages are in the allowlist and
// both V2 + legacy names are matched.

const SUI_RPC = process.env.SUI_RPC_URL || 'https://fullnode.mainnet.sui.io:443';

// Cetus package addresses (allowlist). Matched by PACKAGE — never by event
// name alone — because Momentum emits identically-named liquidity events.
const CETUS_PKGS = [
  '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb', // original — CollectFeeEvent / Open/ClosePositionEvent
  '0xdb5cd62a06c79695bfc9982eb08534706d3752fe123b48e0144f480209b3117f', // V2 pool — Add/RemoveLiquidityV2Event (verified live)
  '0x587614620d0d30aed66d86ffd3ba385a661a86aa573a4d579017068f561c6d8f', // v1.25.0
  '0x3b9f8d381c22bfcf7e4e6469f57a4d10d2087bbfae05248650b08fd5dff0434d', // v1.50.0
];

// Cetus event short-names → our event type. V2 names are what current Cetus
// emits; legacy names kept for older positions.
const DEPOSIT_NAMES = new Set(['AddLiquidityV2Event', 'AddLiquidityEvent']);
const WITHDRAW_NAMES = new Set(['RemoveLiquidityV2Event', 'RemoveLiquidityEvent']);
const FEE_NAMES = new Set(['CollectFeeEvent']);

export type ActivityEventType = 'deposit' | 'withdrawal' | 'fee_claim';

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

interface SuiEvent {
  id: { txDigest: string; eventSeq: string };
  type: string;
  parsedJson: Record<string, unknown>;
  timestampMs?: string;
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

// Fetch all events emitted by transactions SENT by `account`, via the
// event-indexed `suix_queryEvents` API (newest-first). Paginates to full
// history; bails gracefully on any page error (returns what it has so far).
interface EventCursor { txDigest: string; eventSeq: string }
interface QueryEventsPage {
  data?: SuiEvent[];
  nextCursor?: EventCursor | null;
  hasNextPage?: boolean;
}

async function fetchSenderEvents(account: string): Promise<SuiEvent[]> {
  const events: SuiEvent[] = [];
  let cursor: EventCursor | null = null;
  const MAX_PAGES = 200; // safety bound (×50 = 10k events) to stay within fn timeout

  for (let page = 0; page < MAX_PAGES; page++) {
    let result: QueryEventsPage | null = null;
    try {
      result = (await suiRpc('suix_queryEvents', [
        { Sender: account },
        cursor,
        50,
        true, // descending (newest first)
      ])) as QueryEventsPage | null;
    } catch {
      break; // graceful: stop paginating, keep what we have
    }
    if (!result?.data) break;
    events.push(...result.data);
    if (!result.hasNextPage || !result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return events;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const positionId = searchParams.get('positionId'); // raw Sui object ID, or "all"
  const account = searchParams.get('account') ?? '';
  const decimalsA = parseInt(searchParams.get('decimalsA') ?? '9', 10);
  const decimalsB = parseInt(searchParams.get('decimalsB') ?? '6', 10);
  const fallbackA = parseFloat(searchParams.get('priceA') ?? '0');
  const fallbackB = parseFloat(searchParams.get('priceB') ?? '0');

  if (!positionId || !account) {
    return NextResponse.json({ error: 'positionId and account required' }, { status: 400 });
  }
  // Wallet-scope mode (positionId="all"): only fee_claim events, aggregated
  // across every Cetus position the wallet ever held (recovers fees from
  // fully-closed/destroyed positions).
  const walletScope = positionId === 'all';

  try {
    const allEvents = await fetchSenderEvents(account);
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

    for (const ev of allEvents) {
      const parts = ev.type.split('::');
      const pkg = parts[0];
      if (!CETUS_PKGS.includes(pkg)) continue;
      const evName = parts[parts.length - 1];

      const pj = ev.parsedJson ?? {};
      // Cetus position-object id lives in the `position` field across all
      // liquidity + fee events.
      const evPosId = (pj.position as string) ?? '';
      if (!walletScope && evPosId !== positionId) continue;

      let type: ActivityEventType;
      if (FEE_NAMES.has(evName)) type = 'fee_claim';
      else if (DEPOSIT_NAMES.has(evName)) type = 'deposit';
      else if (WITHDRAW_NAMES.has(evName)) type = 'withdrawal';
      else continue;

      // Wallet-scope aggregates fees only (deposits/withdrawals are
      // pool-specific and ambiguous across positions).
      if (walletScope && type !== 'fee_claim') continue;

      const a0 = BigInt((pj.amount_a as string) ?? '0');
      const a1 = BigInt((pj.amount_b as string) ?? '0');
      const ts = ev.timestampMs ? Math.floor(parseInt(ev.timestampMs, 10) / 1000) : 0;

      if (type === 'deposit') { deposited0 += a0; deposited1 += a1; }
      else if (type === 'withdrawal') { withdrawn0 += a0; withdrawn1 += a1; }
      else { fees0 += a0; fees1 += a1; }

      rawEvents.push({ type, txHash: ev.id.txDigest, timestamp: ts, amount0Raw: a0, amount1Raw: a1 });
    }

    // Oldest-first for cumulative fee running total.
    rawEvents.sort((a, b) => a.timestamp - b.timestamp);

    let runningFeeUSD = 0;
    const events: ActivityEvent[] = rawEvents.map((ev) => {
      const amount0 = Number(ev.amount0Raw) / Number(scaleA);
      const amount1 = Number(ev.amount1Raw) / Number(scaleB);

      // Value at current pool-token prices (priceA/priceB from CoinGecko,
      // passed by the caller). Cetus per-position price derivation isn't
      // available here (the position route doesn't expose coin types), so
      // current prices are used for every event type.
      const price0AtTime = fallbackA || null;
      const price1AtTime = fallbackB || null;
      let usdAtTime: number | null = null;
      if (fallbackA > 0 || fallbackB > 0) usdAtTime = amount0 * fallbackA + amount1 * fallbackB;

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
    // Graceful: empty events rather than 500 so the analytics/detail page
    // never breaks on a Cetus RPC hiccup.
    return NextResponse.json({ events: [], netInvested0: 0, netInvested1: 0, totalFees0: 0, totalFees1: 0 } as ActivityResponse);
  }
}
