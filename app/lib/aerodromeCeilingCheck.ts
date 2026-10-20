// Batch E (Job 1, "Option B"): may the Sugar 2,000-pool notice be cleared for a wallet?
//
// Sugar's staked-position loop stops at pool index 2,000 (3,660 CL pools on Base
// on 2026-10-19), so the open sweep alone cannot prove a wallet has no position
// staked in a newer pool. The NFT history (the transfer index) can: every NFT the
// wallet ever held is known, and each one is now burned, held by the wallet,
// staked in a gauge, or somebody else's. The notice clears ONLY when all of this
// holds — otherwise it stays (no silent drops, a failed read is never "owns nothing"):
//
//   1. the history read is complete;
//   2. every NFT has a definite answer (no failed ownerOf / gauge read);
//   3. balanceOf(wallet) on the position manager == NFTs the history says the
//      wallet holds now;
//   4. for every gauge holding one of them, gauge.stakedValues(wallet) == the
//      history's NFTs staked there (the gauge's own count);
//   5. every held or staked NFT is on the list the page shows (none missing).

import { evmRpcPost } from './evmRpc';
import { resolveHolderVerdict } from './evmGaugeStaking';

const SEL_BALANCE_OF = '0x70a08231';
const SEL_OWNER_OF = '0x6352211e';
const SEL_STAKED_VALUES = '0x4b937763'; // stakedValues(address)

export interface CeilingCheck {
  covered: boolean;
  /** Why it is not covered (first failed condition). */
  reason?: string;
  everHeld: number;
  burned: number;
  walletHeld: number;
  staked: number;
  otherOwner: number;
  balanceOf?: number;
  gaugesChecked: number;
  rpcCalls: number;
}

const pad = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');

export async function checkPoolCeilingCoverage(opts: {
  rpc: string;
  nftManager: string;
  voter: string;
  account: string;
  /** Every NFT id the wallet ever received, and the ones the history saw burned. */
  history: { ids: string[]; complete: boolean; burned: Record<string, unknown> | undefined };
  /** Ids on the list the page shows as OPEN (Sugar rows + staked rows from the history pass). */
  shownOpenIds: Set<string>;
}): Promise<CeilingCheck> {
  const acct = opts.account.toLowerCase();
  let calls = 0;
  const out: CeilingCheck = { covered: false, everHeld: opts.history.ids.length, burned: 0, walletHeld: 0, staked: 0, otherOwner: 0, gaugesChecked: 0, rpcCalls: 0 };
  const done = (reason?: string): CeilingCheck => ({ ...out, covered: !reason, ...(reason ? { reason } : {}), rpcCalls: calls });
  if (!opts.history.complete) return done('NFT history not fully read');

  const eth = async (to: string, data: string): Promise<{ result?: string; error?: { message?: string } }> => {
    calls += 1;
    return evmRpcPost(opts.rpc, { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }) as never;
  };

  const live = opts.history.ids.filter((id) => !opts.history.burned?.[id]);
  out.burned = opts.history.ids.length - live.length;
  const walletHeld: string[] = [];
  const stakedByGauge = new Map<string, Set<string>>();
  // Four NFTs at a time (the shared EVM client still paces the gateway).
  type One = { id: string; kind: 'held' | 'staked' | 'burned' | 'other'; gauge?: string } | { id: string; fail: string };
  const one = async (id: string): Promise<One> => {
    let r;
    try { r = await eth(opts.nftManager, SEL_OWNER_OF + pad(BigInt(id).toString(16))); } catch { return { id, fail: `ownerOf(${id}) could not be read` }; }
    if (r.error) {
      if (/revert/i.test(r.error.message ?? '')) return { id, kind: 'burned' }; // burned after the history was read
      return { id, fail: `ownerOf(${id}) could not be read` };
    }
    if (typeof r.result !== 'string' || r.result.length < 66) return { id, fail: `ownerOf(${id}) could not be read` };
    const owner = '0x' + r.result.slice(-40).toLowerCase();
    if (owner === acct) return { id, kind: 'held' };
    let v;
    try { v = await resolveHolderVerdict({ rpc: opts.rpc, nftManager: opts.nftManager, voter: opts.voter, tokenId: id }); calls += 6; }
    catch { return { id, fail: `holder of ${id} could not be read` }; }
    if (v.kind === 'unresolved') return { id, fail: `holder of ${id} could not be read` };
    if (v.kind === 'staked') return { id, kind: 'staked', gauge: v.state.gauge.toLowerCase() };
    if (v.kind === 'burned') return { id, kind: 'burned' }; // zero liquidity
    return { id, kind: 'other' }; // transferred / sold: not this wallet's
  };
  const results: One[] = [];
  for (let i = 0; i < live.length; i += 4) results.push(...await Promise.all(live.slice(i, i + 4).map(one)));
  for (const r of results) {
    if ('fail' in r) return done(r.fail);
    if (r.kind === 'held') walletHeld.push(r.id);
    else if (r.kind === 'staked') (stakedByGauge.get(r.gauge!) ?? stakedByGauge.set(r.gauge!, new Set()).get(r.gauge!)!).add(r.id);
    else if (r.kind === 'burned') out.burned += 1;
    else out.otherOwner += 1;
  }
  out.walletHeld = walletHeld.length;
  out.staked = [...stakedByGauge.values()].reduce((n, s) => n + s.size, 0);

  // 3. balanceOf cross-check.
  let bal;
  try { bal = await eth(opts.nftManager, SEL_BALANCE_OF + pad(acct)); } catch { return done('balanceOf could not be read'); }
  if (bal.error || typeof bal.result !== 'string') return done('balanceOf could not be read');
  out.balanceOf = Number(BigInt(bal.result));
  if (out.balanceOf !== walletHeld.length) return done(`balanceOf ${out.balanceOf} ≠ ${walletHeld.length} held in the NFT history`);

  // 4. Each gauge's own list of this wallet's staked NFTs.
  for (const [gauge, ids] of stakedByGauge) {
    let r;
    try { r = await eth(gauge, SEL_STAKED_VALUES + pad(acct)); } catch { return done(`gauge ${gauge} could not be read`); }
    if (r.error || typeof r.result !== 'string' || r.result.length < 130) return done(`gauge ${gauge} could not be read`);
    const words = r.result.slice(2).match(/.{64}/g) ?? [];
    const n = Number(BigInt('0x' + words[1]));
    const onGauge = new Set(words.slice(2, 2 + n).map((w) => BigInt('0x' + w).toString()));
    out.gaugesChecked += 1;
    if (onGauge.size !== ids.size || [...ids].some((id) => !onGauge.has(id))) return done(`gauge ${gauge} lists ${onGauge.size} staked, history ${ids.size}`);
  }

  // 5. Nothing held or staked is missing from the page.
  const missing = [...walletHeld, ...[...stakedByGauge.values()].flatMap((s) => [...s])].filter((id) => !opts.shownOpenIds.has(id));
  if (missing.length > 0) return done(`${missing.length} held or staked position${missing.length === 1 ? '' : 's'} not listed`);
  return done();
}
