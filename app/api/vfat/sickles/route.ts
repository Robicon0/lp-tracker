// GET /api/vfat/sickles?owner=0x…
//
// Resolves an EOA to its vfat Sickle sub-account(s) — the per-user contract
// wallets that HOLD the user's LP position NFTs. Returns DEPLOYED Sickles only.
//
// Response: { sickles: [{ chain, address }], complete: boolean }
//
// `complete` is false when at least one configured chain's RPC failed. It exists
// so a transient failure is never cached as a confident "this user has no
// Sickle" (see vfatSickleCache).
//
// DEGRADE CONTRACT (architecture Rule 11): a chain whose call fails contributes
// NO result for this load. It never throws and never fails the whole route —
// one chain being down must not remove the other chains' positions, or block
// the page. Discovery is per-user pure-compute + one eth_call per chain: no log
// enumeration, so this is free-tier safe (Alchemy caps eth_getLogs at 10 blocks
// on Base; that limit is irrelevant here).

import { NextResponse } from 'next/server';
import { evmRpcPost } from '../../../lib/evmRpc';
import {
  VFAT_CHAINS,
  vfatRpcUrl,
  encodeSicklesCall,
  decodeAddressResult,
} from '../../../lib/vfatConfig';
import { getCachedSickles, setCachedSickles, type SickleRef } from '../../../lib/vfatSickleCache';

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const owner = searchParams.get('owner');

  // A malformed/missing owner is an empty result, not an error: this route is
  // called speculatively for every EVM address the user has, and a 4xx here
  // would surface as a console error on an ordinary page load.
  if (!owner || !EVM_ADDRESS_RE.test(owner)) {
    return NextResponse.json({ sickles: [], complete: true });
  }
  const ownerLc = owner.toLowerCase();

  const cached = await getCachedSickles(ownerLc);
  if (cached) {
    return NextResponse.json({ sickles: cached, complete: true, cached: true });
  }

  const data = encodeSicklesCall(ownerLc);

  // All chains in parallel — four independent eth_calls, no interdependency.
  // Each settles to either a SickleRef, or null plus an `ok: false` marker so a
  // failure is distinguishable from a genuine "no Sickle on this chain".
  const results = await Promise.all(
    VFAT_CHAINS.map(async (cfg): Promise<{ ok: boolean; ref: SickleRef | null }> => {
      const url = vfatRpcUrl(cfg);
      // No RPC key configured: same graceful degrade as the existing EVM routes.
      if (!url) return { ok: false, ref: null };
      try {
        const res = await evmRpcPost(url, {
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_call',
          params: [{ to: cfg.factory, data }, 'latest'],
        });
        if (res.error) {
          console.warn(`[vfat] ${cfg.chain} sickles() failed: ${res.error.message}`);
          return { ok: false, ref: null };
        }
        const address = decodeAddressResult(res.result);
        return { ok: true, ref: address ? { chain: cfg.chain, address } : null };
      } catch (err) {
        // Defensive: evmRpcPost is documented never to throw, but a chain
        // failure must never take down the other chains regardless.
        console.warn(`[vfat] ${cfg.chain} sickles() threw:`, err);
        return { ok: false, ref: null };
      }
    }),
  );

  const sickles = results.map((r) => r.ref).filter((r): r is SickleRef => r != null);
  const complete = results.every((r) => r.ok);

  setCachedSickles(ownerLc, sickles, complete);

  return NextResponse.json({ sickles, complete });
}
