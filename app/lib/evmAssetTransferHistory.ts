// Wallet NFT-position history WITHOUT wide-range eth_getLogs.
//
// WHY THIS EXISTS
// Closed-position recovery and per-position fee history were built on one
// capability: an archive endpoint that answers `eth_getLogs` over a chain's whole
// history. The public Base gateway withdrew it (1,000-block cap, 2026-10-07), the
// other free endpoints had already gone, and every Base wallet lost its closed
// positions and fee history at once.
//
// This module rebuilds the same data from two things the free Alchemy plan does
// serve: the transfers index (`alchemy_getAssetTransfers`) and transaction
// receipts.
//
//   1. NFT transfers to / from the wallet      → every position it ever held,
//                                                each one's mint tx, burns,
//                                                and where a live NFT was sent
//   2. transactions the wallet sent to the     → the txs that can contain its
//      position manager (and to any contract     deposit / withdrawal / collect
//      it sent an NFT to, e.g. a gauge)          events
//   3. their receipts                          → the events themselves
//
// COMPLETENESS IS CHECKED, NOT ASSUMED. Step 2 only sees transactions the wallet
// sent itself. A position worked through another contract (a vault wallet, a
// router) is invisible to it. So every position's event set is RECONCILED
// against the chain: its liquidity added minus liquidity removed must equal the
// liquidity the position has now (zero once burned), and a burned position must
// have collected at least what it withdrew. A position that does not reconcile
// gets a SECOND lookup — token transfers between the wallet and that position's
// pool, which finds the transactions regardless of who sent them — and if it
// still does not reconcile it is reported `verified: false`. Callers must
// disclose an unverified position and never present its figures as final.
//
// Cached per wallet in Redis and extended incrementally: a finalized block's
// transfers and receipts never change, so a repeat request only asks for what
// happened since the last scan.

import { Redis } from '@upstash/redis';
import { evmRpcPost } from './evmRpc';
import { LOOKUP_FAILED, LOOKUP_UNAVAILABLE } from './enumerationTruncation';
import type { ArchiveChain } from './evmArchiveRpc';

// Uniswap-V3-style NonfungiblePositionManager events (identical topic hashes on
// Aerodrome / Velodrome Slipstream and Uniswap V3).
export const TOPIC_INCREASE_LIQUIDITY = '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f';
export const TOPIC_DECREASE_LIQUIDITY = '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4';
export const TOPIC_COLLECT = '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01';
const TOPIC_POOL_MINT = '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde';
const POSITION_TOPICS = new Set([TOPIC_INCREASE_LIQUIDITY, TOPIC_DECREASE_LIQUIDITY, TOPIC_COLLECT]);
const SEL_POSITIONS = '0x99fbab88'; // positions(uint256); liquidity is return word 7
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const ALCHEMY_NETWORK: Record<ArchiveChain, string> = {
  base: 'base-mainnet',
  ethereum: 'eth-mainnet',
  arbitrum: 'arb-mainnet',
  polygon: 'polygon-mainnet',
  optimism: 'opt-mainnet',
};

// Bounds. Hitting one never produces a confident answer — it marks the result
// incomplete / unverified instead.
const MAX_TRANSFER_PAGES = 20;        // × 1000 transfers per query
const MAX_RECEIPTS_PER_SCAN = 600;    // the rest carry over to the next request
const RECEIPT_CONCURRENCY = 8;        // on top of evmRpc's global semaphore
const MAX_FORWARD_RECIPIENTS = 8;     // gauges etc. the wallet sent NFTs to
const MAX_POOL_LOOKUPS = 6;           // second-lookup pools per scan
const REORG_MARGIN_BLOCKS = 64;       // newest blocks are re-read, never persisted
const MEMO_TTL_MS = 60_000;
const KEY_PREFIX = 'evm_wallet_hist_v1:';
const TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_PERSIST_BYTES = 900_000;
const MAX_UNCHANGED_AGE_MS = 30 * 60 * 1000;
const SEL_BALANCE_OF = '0x70a08231';

export interface HistoryLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}

export interface WalletNftHistory {
  /** The ID SET is complete. False means "we do not know what this wallet held". */
  complete: boolean;
  reason: typeof LOOKUP_FAILED | typeof LOOKUP_UNAVAILABLE | null;
  /** Decimal tokenIds of every position NFT the wallet ever received. */
  ids: string[];
  /** tokenId → hash of the tx in which the wallet first received it. */
  mintTx: Record<string, string>;
  /** tokenId → true when its last movement was a burn. */
  burned: Record<string, boolean>;
  /** tokenId → its Increase / Decrease / Collect logs, oldest first. */
  logsByToken: Record<string, HistoryLog[]>;
  /** tokenId → the event set reconciles with on-chain state. */
  verified: Record<string, boolean>;
}

interface Transfer { id: string; block: number; hash: string; other: string }
interface Stored {
  v: 1;
  cursors: Record<string, number>;      // query key → last block fully scanned
  ins: Transfer[];
  outs: Transfer[];
  seen: string[];                        // tx hashes whose receipts were read
  pending: string[];                     // tx hashes still to read
  logs: HistoryLog[];                    // position-manager logs from those receipts
  pools: Record<string, string>;         // tokenId → pool address
  // Fast-path fingerprint: see `unchanged` in scan().
  sig?: string;
  settled?: boolean;
  at?: number;
  eoa?: boolean;
}

const emptyStored = (): Stored => ({ v: 1, cursors: {}, ins: [], outs: [], seen: [], pending: [], logs: [], pools: {} });

let redis: { get: (k: string) => Promise<unknown>; set: (k: string, v: unknown, o: { ex: number }) => Promise<unknown> } | null = null;
try {
  const url = process.env.PRICE_CACHE_KV_REST_API_URL;
  const token = process.env.PRICE_CACHE_KV_REST_API_TOKEN;
  if (url && token) {
    redis = new Redis({ url, token }) as unknown as typeof redis;
  }
} catch {
  redis = null;
}

function alchemyUrl(chain: ArchiveChain): string {
  const key = (process.env.NEXT_PUBLIC_ALCHEMY_KEY ?? '').trim();
  return key ? `https://${ALCHEMY_NETWORK[chain]}.g.alchemy.com/v2/${key}` : '';
}

class LookupError extends Error {
  constructor(public reason: typeof LOOKUP_FAILED | typeof LOOKUP_UNAVAILABLE, message: string) { super(message); }
}

const hex = (n: number) => '0x' + n.toString(16);
const word = (data: string, i: number): bigint => {
  const d = data.startsWith('0x') ? data.slice(2) : data;
  const w = d.slice(i * 64, (i + 1) * 64);
  return w.length === 64 ? BigInt('0x' + w) : 0n;
};

/** One `alchemy_getAssetTransfers` query, paged, from `fromBlock` to latest. */
async function assetTransfers(
  url: string,
  params: Record<string, unknown>,
  fromBlock: number,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let pageKey: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= MAX_TRANSFER_PAGES) throw new LookupError(LOOKUP_UNAVAILABLE, 'transfer page limit reached');
    const res = await evmRpcPost(url, {
      jsonrpc: '2.0', id: 1, method: 'alchemy_getAssetTransfers',
      params: [{ fromBlock: hex(fromBlock), toBlock: 'latest', maxCount: '0x3e8', ...params, ...(pageKey ? { pageKey } : {}) }],
    }, { timeoutMs: 20_000 });
    if (res.error) {
      const m = String(res.error.message ?? '').toLowerCase();
      const unavailable = m.includes('not supported') || m.includes('unsupported') || m.includes('upgrade') || m.includes('not enabled') || m.includes('method not found');
      throw new LookupError(unavailable ? LOOKUP_UNAVAILABLE : LOOKUP_FAILED, `asset transfers: ${String(res.error.message).slice(0, 80)}`);
    }
    const r = res.result as { transfers?: Array<Record<string, unknown>>; pageKey?: string } | undefined;
    out.push(...(r?.transfers ?? []));
    pageKey = r?.pageKey;
    if (!pageKey) return out;
  }
}

function nftTransfer(t: Record<string, unknown>, otherField: 'from' | 'to'): Transfer | null {
  const raw = (t.erc721TokenId ?? t.tokenId) as string | undefined;
  if (!raw || typeof t.hash !== 'string' || typeof t.blockNum !== 'string') return null;
  try {
    return { id: BigInt(raw).toString(), block: parseInt(t.blockNum, 16), hash: t.hash, other: String(t[otherField] ?? '').toLowerCase() };
  } catch {
    return null;
  }
}

async function scan(chain: ArchiveChain, nftManager: string, wallet: string): Promise<WalletNftHistory> {
  const fail = (reason: typeof LOOKUP_FAILED | typeof LOOKUP_UNAVAILABLE): WalletNftHistory =>
    ({ complete: false, reason, ids: [], mintTx: {}, burned: {}, logsByToken: {}, verified: {} });

  const url = alchemyUrl(chain);
  if (!url) return fail(LOOKUP_UNAVAILABLE);
  const manager = nftManager.toLowerCase();
  const cacheKey = `${KEY_PREFIX}${chain}:${manager}:${wallet}`;

  const t0 = Date.now();
  const marks: string[] = [];
  const mark = (label: string) => marks.push(`${label}=${Date.now() - t0}`);
  let st = emptyStored();
  if (redis) {
    try {
      const hit = await redis.get(cacheKey);
      const parsed = (typeof hit === 'string' ? JSON.parse(hit) : hit) as Stored | null;
      if (parsed?.v === 1 && Array.isArray(parsed.ins)) st = parsed;
    } catch { /* start from an empty scan */ }
  }

  mark('cache');
  // FAST PATH. An externally-owned wallet whose transaction count and NFT
  // balance are both unchanged since a settled scan cannot have opened, closed,
  // staked or modified a position, so the stored history is still the whole
  // history — two cheap calls instead of the transfer queries. A contract wallet
  // (its "nonce" does not track activity) always rescans, and so does anything
  // older than MAX_UNCHANGED_AGE_MS.
  const [nonceRes, balRes, codeRes] = await Promise.all([
    evmRpcPost(url, { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount', params: [wallet, 'latest'] }),
    evmRpcPost(url, { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: manager, data: SEL_BALANCE_OF + wallet.replace(/^0x/, '').padStart(64, '0') }, 'latest'] }),
    st.eoa === undefined
      ? evmRpcPost(url, { jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [wallet, 'latest'] })
      : Promise.resolve(null),
  ]);
  const eoa = st.eoa ?? (codeRes && !codeRes.error && typeof codeRes.result === 'string' ? codeRes.result === '0x' : undefined);
  const sig = typeof nonceRes.result === 'string' && typeof balRes.result === 'string'
    ? `${nonceRes.result}:${balRes.result}`
    : null;
  const unchanged = !!sig && eoa === true && st.sig === sig && st.settled === true
    && st.pending.length === 0 && Date.now() - (st.at ?? 0) < MAX_UNCHANGED_AGE_MS;

  let safeTo = 0;
  if (!unchanged) {
    const headRes = await evmRpcPost(url, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
    const head = typeof headRes.result === 'string' ? parseInt(headRes.result, 16) : NaN;
    if (!Number.isFinite(head)) return fail(LOOKUP_FAILED);
    safeTo = Math.max(0, head - REORG_MARGIN_BLOCKS);
  }

  const cursors = { ...st.cursors };
  const query = async (key: string, params: Record<string, unknown>) => {
    const from = (cursors[key] ?? -1) + 1;
    const rows = await assetTransfers(url, params, from);
    cursors[key] = safeTo;
    return rows;
  };

  const seen = new Set(st.seen);
  const pending = new Set(st.pending);
  const want = (hash: unknown) => { if (typeof hash === 'string' && !seen.has(hash)) pending.add(hash); };

  const insByKey = new Map(st.ins.map((t) => [`${t.hash}:${t.id}`, t]));
  const outsByKey = new Map(st.outs.map((t) => [`${t.hash}:${t.id}`, t]));
  const logsByKey = new Map(st.logs.map((l) => [`${l.transactionHash}:${l.logIndex}`, l]));
  const pools: Record<string, string> = { ...st.pools };
  let receiptsComplete = true;

  const readReceipts = async () => {
    const hashes = [...pending].slice(0, MAX_RECEIPTS_PER_SCAN);
    if (pending.size > hashes.length) receiptsComplete = false;
    for (let i = 0; i < hashes.length; i += RECEIPT_CONCURRENCY) {
      await Promise.all(hashes.slice(i, i + RECEIPT_CONCURRENCY).map(async (hash) => {
        const res = await evmRpcPost(url, { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [hash] });
        const rc = res.result as { status?: string; logs?: HistoryLog[] } | null | undefined;
        if (res.error || !rc || !Array.isArray(rc.logs)) { receiptsComplete = false; return; }
        const poolMint = rc.logs.find((l) => l.topics?.[0] === TOPIC_POOL_MINT && l.address.toLowerCase() !== manager);
        for (const l of rc.logs) {
          if (l.address.toLowerCase() !== manager || !POSITION_TOPICS.has(l.topics?.[0]) || !l.topics[1]) continue;
          logsByKey.set(`${l.transactionHash}:${l.logIndex}`, {
            address: l.address, topics: l.topics, data: l.data,
            blockNumber: l.blockNumber, transactionHash: l.transactionHash, logIndex: l.logIndex,
          });
          if (l.topics[0] === TOPIC_INCREASE_LIQUIDITY && poolMint) {
            const id = BigInt(l.topics[1]).toString();
            if (!pools[id]) pools[id] = poolMint.address.toLowerCase();
          }
        }
        seen.add(hash);
        pending.delete(hash);
      }));
    }
  };

  let idSetComplete = true;
  if (!unchanged) try {
    // 1. Every position NFT in and out.
    const [insRaw, outsRaw] = await Promise.all([
      query('nft-in', { toAddress: wallet, contractAddresses: [manager], category: ['erc721'] }),
      query('nft-out', { fromAddress: wallet, contractAddresses: [manager], category: ['erc721'] }),
    ]);
    for (const t of insRaw) { const x = nftTransfer(t, 'from'); if (x) { insByKey.set(`${x.hash}:${x.id}`, x); want(x.hash); } }
    for (const t of outsRaw) { const x = nftTransfer(t, 'to'); if (x) { outsByKey.set(`${x.hash}:${x.id}`, x); want(x.hash); } }
  } catch (err) {
    const reason = err instanceof LookupError ? err.reason : LOOKUP_FAILED;
    console.warn(`[evmAssetTransferHistory] ${chain} NFT transfer lookup did not complete (${reason})`);
    if (insByKey.size === 0) return fail(reason);
    idSetComplete = false; // serve what an earlier scan found, flagged
  }

  mark('nft');
  const ins = [...insByKey.values()];
  const outs = [...outsByKey.values()];
  const ids = [...new Set(ins.map((t) => t.id))];
  if (ids.length === 0) {
    return { complete: idSetComplete, reason: idSetComplete ? null : LOOKUP_FAILED, ids: [], mintTx: {}, burned: {}, logsByToken: {}, verified: {} };
  }

  if (!unchanged) try {
    // 2. Transactions the wallet sent to the position manager, and to any
    //    contract it handed an NFT to (a gauge keeps emitting the position's
    //    events while it holds the NFT).
    const forward = [...new Set(outs.map((t) => t.other).filter((a) => a && a !== ZERO_ADDRESS))].slice(0, MAX_FORWARD_RECIPIENTS);
    const direct = await Promise.all([manager, ...forward].map((to) =>
      query(`ext:${to}`, { fromAddress: wallet, toAddress: to, category: ['external'], excludeZeroValue: false })));
    for (const rows of direct) for (const t of rows) want(t.hash);
    // 3. Their receipts.
    await readReceipts();
  } catch (err) {
    receiptsComplete = false;
    console.warn(`[evmAssetTransferHistory] ${chain} transaction lookup did not complete: ${err instanceof Error ? err.message : 'error'}`);
  }

  mark('receipts');
  const mintTx: Record<string, string> = {};
  const burned: Record<string, boolean> = {};
  for (const id of ids) {
    const mine = ins.filter((t) => t.id === id).sort((a, b) => a.block - b.block);
    mintTx[id] = mine[0].hash;
    const lastIn = mine[mine.length - 1].block;
    const lastOut = outs.filter((t) => t.id === id).sort((a, b) => b.block - a.block)[0];
    burned[id] = !!lastOut && lastOut.other === ZERO_ADDRESS && lastOut.block >= lastIn;
  }

  const group = (): Record<string, HistoryLog[]> => {
    const by: Record<string, HistoryLog[]> = {};
    for (const id of ids) by[id] = [];
    for (const l of logsByKey.values()) {
      let id: string;
      try { id = BigInt(l.topics[1]).toString(); } catch { continue; }
      if (by[id]) by[id].push(l);
    }
    for (const id of ids) {
      by[id].sort((a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16) || parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16));
    }
    return by;
  };

  // Reconcile one position's events against the chain.
  const liveLiquidity = new Map<string, bigint | null>();
  const reconciles = async (id: string, logs: HistoryLog[]): Promise<boolean> => {
    let liq = 0n, dec0 = 0n, dec1 = 0n, col0 = 0n, col1 = 0n, increases = 0;
    for (const l of logs) {
      if (l.topics[0] === TOPIC_INCREASE_LIQUIDITY) { liq += word(l.data, 0); increases++; }
      else if (l.topics[0] === TOPIC_DECREASE_LIQUIDITY) { liq -= word(l.data, 0); dec0 += word(l.data, 1); dec1 += word(l.data, 2); }
      else { col0 += word(l.data, 1); col1 += word(l.data, 2); }
    }
    if (increases === 0) return false; // a position always has a deposit
    if (burned[id]) return liq === 0n && col0 >= dec0 && col1 >= dec1;
    if (!liveLiquidity.has(id)) {
      const res = await evmRpcPost(url, {
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: manager, data: SEL_POSITIONS + BigInt(id).toString(16).padStart(64, '0') }, 'latest'],
      });
      const r = typeof res.result === 'string' && res.result.length >= 2 + 8 * 64 ? word(res.result, 7) : null;
      liveLiquidity.set(id, res.error ? null : r);
    }
    const live = liveLiquidity.get(id);
    return live != null && liq === live;
  };

  let logsByToken = group();
  const verified: Record<string, boolean> = {};
  const check = async () => {
    await Promise.all(ids.map(async (id) => { verified[id] = receiptsComplete && await reconciles(id, logsByToken[id]); }));
  };
  await check();
  mark('verify');

  // SECOND LOOKUP — for positions that did not reconcile: token transfers
  // between the wallet and the position's pool, whoever sent the transaction.
  const failing = ids.filter((id) => !verified[id]);
  if (failing.length > 0 && receiptsComplete && !unchanged) {
    const poolSet = [...new Set(failing.map((id) => pools[id]).filter(Boolean))].slice(0, MAX_POOL_LOOKUPS);
    try {
      for (const pool of poolSet) {
        const [toPool, fromPool] = await Promise.all([
          query(`erc20-out:${pool}`, { fromAddress: wallet, toAddress: pool, category: ['erc20'] }),
          query(`erc20-in:${pool}`, { fromAddress: pool, toAddress: wallet, category: ['erc20'] }),
        ]);
        for (const t of [...toPool, ...fromPool]) want(t.hash);
      }
      if (pending.size > 0) {
        await readReceipts();
        logsByToken = group();
        liveLiquidity.clear();
        await check();
      }
    } catch (err) {
      console.warn(`[evmAssetTransferHistory] ${chain} second lookup did not complete: ${err instanceof Error ? err.message : 'error'}`);
    }
  }

  const unverified = ids.filter((id) => !verified[id]).length;
  console.log(`[evmAssetTransferHistory] ${chain} wallet scan: ${ids.length} positions, ${seen.size} receipts, ${unverified} unverified${idSetComplete ? '' : ', id set INCOMPLETE'}${unchanged ? ' (unchanged since last scan)' : ''} [ms ${marks.join(' ')} total=${Date.now() - t0}]`);

  // Persist only what is final: nothing from the newest blocks.
  if (redis && idSetComplete && !unchanged) {
    const blockOf = (l: HistoryLog) => parseInt(l.blockNumber, 16);
    const finalLogs = [...logsByKey.values()].filter((l) => blockOf(l) <= safeTo);
    const finalHashes = new Set(finalLogs.map((l) => l.transactionHash));
    const recentHashes = new Set([...logsByKey.values()].filter((l) => blockOf(l) > safeTo).map((l) => l.transactionHash));
    const next: Stored = {
      v: 1,
      // A cursor only advances after its query returned, and every hash that
      // query produced is in `seen` or `pending`, so this is safe to keep even
      // when a later step failed.
      cursors,
      ins: ins.filter((t) => t.block <= safeTo),
      outs: outs.filter((t) => t.block <= safeTo),
      seen: [...seen].filter((h) => !recentHashes.has(h) || finalHashes.has(h)),
      pending: [...pending],
      logs: finalLogs,
      pools,
      // The fingerprint was read BEFORE the queries, so anything the wallet does
      // after it changes the next request's fingerprint. `settled` is false
      // while any fetched item is too new to persist — the next request rescans.
      ...(sig ? { sig } : {}),
      settled: receiptsComplete && pending.size === 0
        && ins.every((t) => t.block <= safeTo) && outs.every((t) => t.block <= safeTo)
        && finalLogs.length === logsByKey.size,
      at: Date.now(),
      ...(eoa !== undefined ? { eoa } : {}),
    };
    try {
      const body = JSON.stringify(next);
      if (body.length <= MAX_PERSIST_BYTES) redis.set(cacheKey, body, { ex: TTL_SECONDS }).catch(() => {});
    } catch { /* never block the response on the cache */ }
  }

  return { complete: idSetComplete, reason: idSetComplete ? null : LOOKUP_FAILED, ids, mintTx, burned, logsByToken, verified };
}

// In-flight dedup + a short memo: the positions route, the wallet-scope fee
// scan and every per-position request for one wallet share ONE scan.
const memo = new Map<string, { at: number; promise: Promise<WalletNftHistory> }>();

export function getWalletNftHistory(opts: {
  chain: ArchiveChain;
  nftManager: string;
  wallet: string;
}): Promise<WalletNftHistory> {
  const wallet = opts.wallet.toLowerCase();
  const key = `${opts.chain}:${opts.nftManager.toLowerCase()}:${wallet}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.promise;
  const promise = scan(opts.chain, opts.nftManager, wallet).catch((err): WalletNftHistory => {
    console.error(`[evmAssetTransferHistory] ${opts.chain} scan threw: ${err instanceof Error ? err.message : 'error'}`);
    return { complete: false, reason: LOOKUP_FAILED, ids: [], mintTx: {}, burned: {}, logsByToken: {}, verified: {} };
  });
  memo.set(key, { at: Date.now(), promise });
  // A failed scan must not be served for the rest of the memo window.
  promise.then((h) => { if (!h.complete && memo.get(key)?.promise === promise) memo.delete(key); });
  if (memo.size > 500) for (const [k, v] of memo) if (Date.now() - v.at >= MEMO_TTL_MS) memo.delete(k);
  return promise;
}

/**
 * One position's events from its holder's history — ONLY when that event set
 * reconciles with on-chain state. Null means "not available from this source",
 * never "no events".
 */
export async function getVerifiedPositionLogs(opts: {
  chain: ArchiveChain;
  nftManager: string;
  tokenId: string;
  owner: string;
}): Promise<HistoryLog[] | null> {
  if (!opts.owner) return null;
  const history = await getWalletNftHistory({ chain: opts.chain, nftManager: opts.nftManager, wallet: opts.owner });
  return history.verified[opts.tokenId] ? history.logsByToken[opts.tokenId] : null;
}
