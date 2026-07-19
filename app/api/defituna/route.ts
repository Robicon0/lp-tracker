// DefiTuna (Solana) — WRAPPER-PROTOCOL positions (Sprint WRAPPER-PROTOCOLS,
// Phase 1: OPEN positions).
//
// DefiTuna manages LEVERAGED Orca LP positions: the underlying Whirlpool
// position NFT sits in Tuna's vault (program tuna4uSQZncNeeiAMKbstuxA9CUkHH6
// HmC64wgmnogD), NOT the user's wallet — so the normal Orca NFT census can
// never see these positions (the Krishna investigation, 2026-07-19).
//
// HYBRID SOURCE (Osho-approved design): DefiTuna's PUBLIC API is primary —
// it is the protocol's own valuation (LP totals, live debt with accrued
// interest, collateral, pending yield, leverage), matching their app. Every
// returned position is then VERIFIED ON-CHAIN before display: the TunaPosition
// account must exist, be owned by the tuna program, and carry the requesting
// wallet's pubkey as `authority` (byte offset 11 of the 339-byte account —
// verified against a live account; bump-first-style layout, the Raydium
// lesson). A position the chain doesn't back is dropped LOUDLY, never shown.
//
// VALUE SEMANTICS (Osho-approved): `value` = EQUITY (total − debt) — what the
// user actually owns. The raw LP total would overstate by the borrowed funds.
// `fees` = pending yield (uncollected). `selfReportedPnl` carries the user's
// deposited collateral + open date so useLpPnl computes
//   netPnl = equity + pending yield − deposited collateral
// without an activity route (none exists for wrapper positions; closed-Tuna
// reconstruction is the queued Phase 2).
//
// Range status: tick comparison against the embedded market.pool's
// tick_current_index (exact); composition (single-sided ⇒ out of range) is
// the fallback if the pool object is ever absent.

import { NextResponse } from 'next/server';

const TUNA_API = 'https://api.defituna.com/api/v1';
const TUNA_PROGRAM = 'tuna4uSQZncNeeiAMKbstuxA9CUkHH6HmC64wgmnogD';
const AUTHORITY_OFFSET = 11; // byte offset of the authority pubkey in TunaPosition (339 bytes)
const HELIUS_KEY = process.env.HELIUS_API_KEY;

interface TunaUsd { amount: string; usd: number }
interface TunaItem {
  address: string;
  authority: string;
  state: string;
  position_mint: string;
  liquidity: string;
  tick_lower_index: number;
  tick_upper_index: number;
  leverage: number;
  market: string;
  deposited_collateral_a: TunaUsd;
  deposited_collateral_b: TunaUsd;
  current_debt_a: TunaUsd;
  current_debt_b: TunaUsd;
  yield_a: TunaUsd;
  yield_b: TunaUsd;
  total_a: TunaUsd;
  total_b: TunaUsd;
  pnl_usd?: { amount: string; usd?: number };
  opened_at?: string;
}
interface TunaMint { address: string; symbol: string; decimals?: number }
// markets[addr].pool is an EMBEDDED pool object (verified live): carries the
// pool's mint_a/mint_b and tick_current_index — exact pair identity and true
// range status per position, no extra fetch.
interface TunaMarket { pool?: { address: string; mint_a: string; mint_b: string; tick_current_index: number } }

// Base58 decode (no external dep in routes) — standard alphabet.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(str: string): Uint8Array {
  const bytes: number[] = [0];
  for (const c of str) {
    const v = B58.indexOf(c);
    if (v < 0) return new Uint8Array(0);
    let carry = v;
    for (let i = 0; i < bytes.length; i++) {
      const x = bytes[i] * 58 + carry;
      bytes[i] = x & 0xff;
      carry = x >> 8;
    }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const c of str) { if (c === '1') bytes.push(0); else break; }
  return new Uint8Array(bytes.reverse());
}

// On-chain safety check (hybrid contract): every API-reported position must be
// backed by a live TunaPosition account whose authority IS the wallet. Returns
// the set of verified addresses; on a transient RPC failure returns null (the
// caller keeps API results and logs loudly — availability over false-negative
// dropping; a MISMATCH, by contrast, always drops).
async function verifyOnChain(addresses: string[], wallet: string): Promise<Set<string> | null> {
  if (!HELIUS_KEY || addresses.length === 0) return addresses.length === 0 ? new Set() : null;
  try {
    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts',
        params: [addresses, { encoding: 'base64' }],
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const infos = json?.result?.value;
    if (!Array.isArray(infos)) return null;
    const walletBytes = b58decode(wallet);
    const verified = new Set<string>();
    infos.forEach((info: { owner?: string; data?: [string, string] } | null, i: number) => {
      if (!info || info.owner !== TUNA_PROGRAM || !info.data) {
        console.error(`[defituna] on-chain verification FAILED for ${addresses[i]} — account missing or wrong owner; dropping from display`);
        return;
      }
      const buf = Buffer.from(info.data[0], 'base64');
      const auth = buf.subarray(AUTHORITY_OFFSET, AUTHORITY_OFFSET + 32);
      if (Buffer.compare(auth, Buffer.from(walletBytes)) === 0) verified.add(addresses[i]);
      else console.error(`[defituna] on-chain verification FAILED for ${addresses[i]} — authority mismatch; dropping from display`);
    });
    return verified;
  } catch (err) {
    console.error('[defituna] on-chain verification RPC error (keeping API results this load):', String(err).slice(0, 120));
    return null;
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = searchParams.get('account');
  if (!account) return NextResponse.json({ error: 'account required' }, { status: 400 });

  let payload: { items: TunaItem[]; markets: Record<string, TunaMarket>; mints: Record<string, TunaMint> };
  try {
    const res = await fetch(`${TUNA_API}/users/${encodeURIComponent(account)}/tuna-positions`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
      cache: 'no-store',
    });
    if (!res.ok) {
      console.error(`[defituna] API HTTP ${res.status} for ${account.slice(0, 8)}…`);
      return NextResponse.json({ error: `defituna-api-http-${res.status}` }, { status: 502 });
    }
    payload = (await res.json())?.data ?? { items: [], markets: {}, mints: {} };
  } catch (err) {
    console.error('[defituna] API fetch failed:', String(err).slice(0, 120));
    return NextResponse.json({ error: 'defituna-api-unreachable' }, { status: 502 });
  }

  const open = (payload.items ?? []).filter((it) => it.state === 'open' && it.authority === account);
  const verified = await verifyOnChain(open.map((it) => it.address), account);
  const items = verified === null ? open : open.filter((it) => verified.has(it.address));

  const mints = payload.mints ?? {};
  const symbolOf = (mint: string | undefined) => (mint && mints[mint]?.symbol) || '?';

  const positions = items.map((it) => {
    const totalUsd = (it.total_a?.usd ?? 0) + (it.total_b?.usd ?? 0);
    const debtUsd = (it.current_debt_a?.usd ?? 0) + (it.current_debt_b?.usd ?? 0);
    const equity = Math.max(0, totalUsd - debtUsd);
    const yieldUsd = (it.yield_a?.usd ?? 0) + (it.yield_b?.usd ?? 0);
    const collateralUsd = (it.deposited_collateral_a?.usd ?? 0) + (it.deposited_collateral_b?.usd ?? 0);
    const openedTs = it.opened_at ? Math.floor(Date.parse(it.opened_at) / 1000) : undefined;

    // Pair + range status from the embedded market.pool (exact per-position):
    const pool = (payload.markets ?? {})[it.market]?.pool;
    const symA = symbolOf(pool?.mint_a);
    const symB = symbolOf(pool?.mint_b);
    const inRange = pool
      ? pool.tick_current_index >= it.tick_lower_index && pool.tick_current_index < it.tick_upper_index
      : (it.total_a?.usd ?? 0) > 0 && (it.total_b?.usd ?? 0) > 0; // composition fallback

    return {
      id: `tuna-${it.address}`,
      pair: `${symA} / ${symB}`,
      protocol: 'DefiTuna',
      chain: 'Solana',
      value: equity,
      apy: 0, // Tuna pools aren't on DefiLlama; the derived-APR fallback covers display
      fees: yieldUsd,
      status: (inRange ? 'In Range' : 'Out of Range') as 'In Range' | 'Out of Range',
      tickLower: it.tick_lower_index,
      tickUpper: it.tick_upper_index,
      liquidity: it.liquidity,
      // Wrapper self-reported P&L basis (see useLpPnl.buildSelfReportedPnL):
      selfReportedPnl: { initialValueUSD: collateralUsd, openedTs },
      // Display extras (leverage shown on the row's sub-line in future UI work)
      leverage: it.leverage,
      debtUSD: debtUsd,
      totalUSD: totalUsd,
    };
  });

  return NextResponse.json({ positions, count: positions.length, account });
}
