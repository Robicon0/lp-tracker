// GET /api/evm/token-balances?address=0x…&chain=ethereum|base|arbitrum|optimism|polygon[&limit=50]
//
// The wallet-token views used to call Alchemy straight from the browser with the
// public key (useWalletTokens, the wallet page). This route makes the same three
// calls server-side, so they go through the one limiter (alchemyLimiter.ts), the
// key can leave the bundle, and token metadata is read once per token for every
// user (token_meta_v1, 90 d) instead of once per view. Same data back: the native
// balance (raw hex), the non-zero ERC-20 balances in Alchemy's order, and for the
// first `limit` of them the metadata Alchemy gives (symbol, decimals, name, logo).
//
// Failure is a non-200 (rule (e)): a balance read that did not answer is never
// "owns nothing". A token whose metadata could not be read comes back with
// `meta: null` and is counted (`metaFailed`).

import { NextResponse } from 'next/server';
import { alchemyUrl } from '../../../lib/alchemyKey';
import { getCachedTokenMeta, setCachedTokenMeta } from '../../../lib/tokenMetaCache';

export const dynamic = 'force-dynamic';

const CHAINS = new Set(['ethereum', 'base', 'arbitrum', 'optimism', 'polygon']);
const ZERO_HEX = '0x0000000000000000000000000000000000000000000000000000000000000000';
const BAL_TTL_MS = 15_000; // one page load asks several times (dashboard + analytics)

export interface TokenMetaOut { symbol: string | null; decimals: number | null; name: string | null; logo: string | null }
export interface TokenBalancesResponse {
  chain: string;
  address: string;
  nativeHex: string;
  tokens: Array<{ contractAddress: string; tokenBalance: string; meta: TokenMetaOut | null }>;
  nonZeroCount: number;
  metaFailed: number;
}

class RpcError extends Error {}

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(12_000), cache: 'no-store',
  });
  if (!res.ok) throw new RpcError(`${method} HTTP ${res.status}`);
  const j = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (j.error || j.result === undefined) throw new RpcError(`${method} ${j.error?.message ?? 'no result'}`);
  return j.result;
}

const memoBal = new Map<string, { at: number; p: Promise<{ nativeHex: string; balances: Array<{ contractAddress: string; tokenBalance: string }> }> }>();

function balancesOf(url: string, chain: string, address: string) {
  const k = `${chain}:${address}`;
  const hit = memoBal.get(k);
  if (hit && Date.now() - hit.at < BAL_TTL_MS) return hit.p;
  const p = (async () => {
    const [nativeHex, tb] = await Promise.all([
      rpc(url, 'eth_getBalance', [address, 'latest']) as Promise<string>,
      rpc(url, 'alchemy_getTokenBalances', [address, 'erc20']) as Promise<{ tokenBalances?: Array<{ contractAddress: string; tokenBalance: string }> }>,
    ]);
    const balances = (tb.tokenBalances ?? []).filter((t) => t.tokenBalance && t.tokenBalance !== ZERO_HEX);
    return { nativeHex, balances };
  })();
  memoBal.set(k, { at: Date.now(), p });
  p.catch(() => { if (memoBal.get(k)?.p === p) memoBal.delete(k); });
  return p;
}

async function metaOf(url: string, chain: string, contract: string): Promise<TokenMetaOut | null> {
  const cached = (await getCachedTokenMeta(chain, contract)) as (TokenMetaOut & { decimals: number }) | null;
  // Only an entry written by this route carries `logo` (null included); anything
  // else is read again so the answer is exactly what Alchemy gives.
  if (cached && 'logo' in cached) return { symbol: cached.symbol, decimals: cached.decimals, name: cached.name ?? null, logo: cached.logo ?? null };
  try {
    const m = (await rpc(url, 'alchemy_getTokenMetadata', [contract])) as { symbol?: string | null; decimals?: number | null; name?: string | null; logo?: string | null };
    const out: TokenMetaOut = { symbol: m?.symbol ?? null, decimals: m?.decimals ?? null, name: m?.name ?? null, logo: m?.logo ?? null };
    if (out.symbol && Number.isInteger(out.decimals)) setCachedTokenMeta(chain, contract, out as never);
    return out;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const address = (searchParams.get('address') ?? '').toLowerCase();
  const chain = (searchParams.get('chain') ?? '').toLowerCase();
  const limit = Math.min(50, Math.max(1, parseInt(searchParams.get('limit') ?? '50', 10) || 50));
  if (!/^0x[0-9a-f]{40}$/.test(address) || !CHAINS.has(chain)) {
    return NextResponse.json({ error: 'address and chain required' }, { status: 400 });
  }
  const url = alchemyUrl(chain);
  if (!url) return NextResponse.json({ error: 'token-balances-unavailable', reason: 'no Alchemy key configured' }, { status: 503 });
  try {
    const { nativeHex, balances } = await balancesOf(url, chain, address);
    const top = balances.slice(0, limit);
    const metas = await Promise.all(top.map((t) => metaOf(url, chain, t.contractAddress)));
    const body: TokenBalancesResponse = {
      chain, address, nativeHex,
      tokens: top.map((t, i) => ({ contractAddress: t.contractAddress, tokenBalance: t.tokenBalance, meta: metas[i] })),
      nonZeroCount: balances.length,
      metaFailed: metas.filter((m) => m === null).length,
    };
    return NextResponse.json(body);
  } catch (err) {
    // The limiter already retried a 429 (AlchemyThrottledError); never an empty list.
    console.warn(`[token-balances] ${chain} read failed: ${err instanceof Error ? err.message : 'error'}`);
    return NextResponse.json({ error: 'token-balances-read-failed', chain }, { status: 503 });
  }
}
