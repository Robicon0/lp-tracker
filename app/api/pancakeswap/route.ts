import { NextResponse } from 'next/server';
import { PositionListReadError, logPositionListReadFailure } from '../../lib/positionListRead';
import { unsupportedPositionsNotice } from '../../lib/enumerationTruncation';
import { alchemyKey } from '../../lib/alchemyKey';

// PancakeSwap V3 on BNB: positions are NOT read yet (2026-10-25, owner decision).
// The route used `positions(uint256)` selector 0x99fd0e82, which reverts, so it
// never read a position for any wallet and answered 503 for every holder.
// Swapping only the selector (0x99fbab88) returned 26 NFTs valued at $6.8e24
// (range-midpoint estimate, unknown tokens), so that was not shipped. Until the
// Uniswap-style rebuild (slot0, pending fees, resolver pricing, plausibility
// guard; post-event list), the route counts the wallet's position NFTs and
// answers the "can't read yet" notice: "PancakeSwap V3 / BNB: N positions we
// can't read yet", totals marked ≈. The old decode path is in git history
// (before this commit). A failed count is a named 503, never "owns nothing"
// (Methodology rule (e)).

const ALCHEMY_KEY = alchemyKey();
const RPC = `https://bnb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;

const POSITION_MANAGER = '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364';

const SELECTORS = {
  balanceOf: '0x70a08231',
};

function padAddress(addr: string): string {
  return addr.toLowerCase().replace('0x', '').padStart(64, '0');
}

// One eth_call to the BNB RPC. The reply is checked before it is read: an HTTP
// error, an empty body or a body that is not JSON is retried (the BNB endpoint
// now and then answers 200 with nothing, which used to fail the whole route as a
// bare 500 "Unexpected end of JSON input"), and after RPC_ATTEMPTS it throws
// PositionListReadError, which the route answers as a named 503. A JSON-RPC
// error or a missing result is the same failed read, never "0x" read as an
// answer. Throttling (429) is retried by the shared Alchemy limiter first.
const RPC_ATTEMPTS = 3;
const RPC_RETRY_MS = [300, 900];
async function rpcCall(to: string, data: string): Promise<string> {
  let why = 'no reply';
  for (let attempt = 0; attempt < RPC_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, RPC_RETRY_MS[attempt - 1]));
    let res: Response;
    try {
      res = await fetch(RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to, data }, 'latest'], id: 1 }),
      });
    } catch (err) {
      why = err instanceof Error && err.name === 'AlchemyThrottledError' ? 'throttled (429)' : 'network error';
      if (why === 'throttled (429)') break; // the limiter has already backed off and retried
      continue;
    }
    if (!res.ok) { why = `HTTP ${res.status}`; continue; }
    const text = await res.text();
    if (!text.trim()) { why = 'empty reply'; continue; }
    let json: { result?: unknown; error?: { message?: string } };
    try { json = JSON.parse(text); } catch { why = 'reply is not JSON'; continue; }
    if (json.error) { why = `RPC error ${String(json.error.message ?? '').slice(0, 60)}`; continue; }
    if (typeof json.result !== 'string') { why = 'reply without a result'; continue; }
    return json.result;
  }
  throw new PositionListReadError('PancakeSwap', `BNB RPC read (${why})`);
}

async function getBalance(account: string): Promise<number> {
  const result = await rpcCall(POSITION_MANAGER, SELECTORS.balanceOf + padAddress(account));
  // balanceOf always answers a 32-byte word. No word is a failed read, never "owns nothing".
  if (!result || result === '0x') throw new PositionListReadError('PancakeSwap', 'NFT balance');
  return parseInt(result, 16);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = searchParams.get('account');

  if (!account) {
    return NextResponse.json({ error: 'Account address required' }, { status: 400 });
  }
  if (!ALCHEMY_KEY) {
    return NextResponse.json({ error: 'Alchemy API key not configured' }, { status: 500 });
  }

  try {
    const balance = await getBalance(account);
    if (balance === 0) {
      return NextResponse.json({ positions: [], count: 0, account });
    }
    return NextResponse.json({
      positions: [],
      count: 0,
      account,
      truncated: [unsupportedPositionsNotice('V3 / BNB', balance)],
    });
  } catch (err) {
    if (err instanceof PositionListReadError) {
      logPositionListReadFailure('PancakeSwap', account, err);
      return NextResponse.json({ error: 'position-list-read-failed', protocol: 'PancakeSwap' }, { status: 503 });
    }
    console.error('PancakeSwap V3 API error:', err);
    return NextResponse.json({ error: 'Failed to fetch positions' }, { status: 500 });
  }
}
