// The position NFTs a wallet itself BURNED on one chain's position manager:
// every Transfer(from = wallet, to = 0x0). Only the owner (or an operator it
// approved) can burn a position, and a burned tokenId is never minted again,
// so this list is exactly the wallet's closed-and-burned positions, read from
// one query instead of one positions() call per tokenId it ever received
// (Uniswap closed half, 2026-10-28: 200 such calls cost about 5,200 Alchemy CU,
// 25-35 s at the instance limit, per chain, for a wallet with many positions).
//
// Two sources, as getEverOwnedTokenIds has: the archive gateway's eth_getLogs
// where it serves wide ranges, and the transfer index (alchemy_getAssetTransfers)
// otherwise or when the gateway fails. A failed read is `complete: false`, never
// "burned nothing".
//
// Saved per wallet as `evm_burned_ids_v1:{chain}:{manager}:{wallet}`, no expiry
// (a burn is permanent): { v, ids, cursor }. Only burns at or below
// `head - REORG_MARGIN_BLOCKS[chain]` are saved, and the cursor stops there, so
// every update reads the newest margin of blocks again; burns inside it are
// returned but not saved. The saved list only grows, and only a complete read
// is saved. Outside production nothing is written (app/lib/sharedStore.ts).

import { evmRpcPost } from './evmRpc';
import { LOOKUP_FAILED, LOOKUP_UNAVAILABLE } from './enumerationTruncation';
import { archiveRpcUrl, archiveServesWideLogs, type ArchiveChain } from './evmArchiveRpc';
import { alchemyUrl, assetTransfers, LookupError } from './evmAssetTransferHistory';
import { createSharedRedis } from './sharedStore';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_TOPIC = '0x' + '0'.repeat(64);
const KEY_PREFIX = 'evm_burned_ids_v1:';

/**
 * Newest blocks read again on every update and never saved: about 30 minutes
 * of each chain. That is past Ethereum finality (2 epochs, about 13 minutes)
 * and past the point where the rollups' blocks are posted to and finalised on
 * Ethereum in normal operation; re-reading it costs nothing extra (it is the
 * same single query).
 */
export const REORG_MARGIN_BLOCKS: Record<ArchiveChain, number> = {
  ethereum: 150,    // 12 s blocks
  arbitrum: 7_200,  // 0.25 s
  polygon: 900,     // 2 s
  optimism: 900,    // 2 s
  base: 900,        // 2 s
};

export interface BurnedIdsResult {
  /** Decimal tokenId strings, oldest burn first. Possibly PARTIAL: check `complete`. */
  ids: string[];
  complete: boolean;
  reason: typeof LOOKUP_FAILED | typeof LOOKUP_UNAVAILABLE | null;
}

interface Stored { v: 1; ids: string[]; cursor: number }

type Store = { get: (k: string) => Promise<unknown>; set: (k: string, v: string) => Promise<unknown> } | null;
const sharedRedis = createSharedRedis('evmBurnedNftIds') as unknown as Store;

interface Burn { id: string; block: number }

const hex = (n: number) => '0x' + n.toString(16);

async function headBlock(url: string): Promise<number> {
  const res = await evmRpcPost(url, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
  const head = typeof res.result === 'string' ? parseInt(res.result, 16) : NaN;
  if (!Number.isFinite(head)) throw new LookupError(LOOKUP_FAILED, `head block: ${res.error?.message ?? 'no result'}`);
  return head;
}

/** The archive gateway: one eth_getLogs over [from, head]. */
async function burnsFromLogs(chain: ArchiveChain, manager: string, wallet: string, from: number): Promise<{ burns: Burn[]; head: number }> {
  const url = archiveRpcUrl(chain);
  if (!url) throw new LookupError(LOOKUP_UNAVAILABLE, 'no archive endpoint');
  const head = await headBlock(url);
  if (from > head) return { burns: [], head };
  const res = await evmRpcPost(url, {
    jsonrpc: '2.0', id: 1, method: 'eth_getLogs',
    params: [{
      address: manager,
      topics: [TRANSFER_TOPIC, '0x' + wallet.replace(/^0x/, '').padStart(64, '0'), ZERO_TOPIC],
      fromBlock: hex(from),
      toBlock: hex(head),
    }],
  }, { timeoutMs: 30_000 });
  if (res.error || !Array.isArray(res.result)) {
    const m = `${res.error?.message ?? ''} ${JSON.stringify((res.error as { data?: unknown } | undefined)?.data ?? '')}`.toLowerCase();
    const unavailable = m.includes('block range') || m.includes('range too large') || m.includes('archive request') || m.includes('personal token');
    throw new LookupError(unavailable ? LOOKUP_UNAVAILABLE : LOOKUP_FAILED, `getLogs: ${String(res.error?.message ?? 'no result').slice(0, 80)}`);
  }
  const burns: Burn[] = [];
  for (const l of res.result as Array<{ topics?: string[]; blockNumber?: string }>) {
    if (!l.topics?.[3] || typeof l.blockNumber !== 'string') throw new LookupError(LOOKUP_FAILED, 'getLogs: malformed log');
    burns.push({ id: BigInt(l.topics[3]).toString(), block: parseInt(l.blockNumber, 16) });
  }
  return { burns, head };
}

/** The transfer index: NFT transfers from the wallet to the zero address. */
async function burnsFromTransferIndex(chain: ArchiveChain, manager: string, wallet: string, from: number): Promise<{ burns: Burn[]; head: number }> {
  const url = alchemyUrl(chain);
  if (!url) throw new LookupError(LOOKUP_UNAVAILABLE, 'no transfer index key');
  const head = await headBlock(url);
  if (from > head) return { burns: [], head };
  const rows = await assetTransfers(url, {
    fromAddress: wallet, toAddress: ZERO_ADDRESS, contractAddresses: [manager], category: ['erc721'], toBlock: hex(head),
  }, from);
  const burns: Burn[] = [];
  for (const t of rows) {
    const raw = (t.erc721TokenId ?? t.tokenId) as string | undefined;
    if (!raw || typeof t.blockNum !== 'string') throw new LookupError(LOOKUP_FAILED, 'asset transfers: malformed row');
    burns.push({ id: BigInt(raw).toString(), block: parseInt(t.blockNum, 16) });
  }
  return { burns, head };
}

/** Pure: the list to return and the record to save. Exported for the tests. */
export function mergeBurns(
  stored: Stored | null,
  burns: readonly Burn[],
  head: number,
  margin: number,
  fromBlock: number,
): { ids: string[]; save: Stored } {
  const ordered = [...burns].sort((a, b) => a.block - b.block);
  const safeTo = Math.max(fromBlock - 1, head - margin);
  const keep = new Set(stored?.ids ?? []);
  const savedIds = [...(stored?.ids ?? [])];
  for (const b of ordered) if (b.block <= safeTo && !keep.has(b.id)) { keep.add(b.id); savedIds.push(b.id); }
  const all = [...savedIds];
  for (const b of ordered) if (!keep.has(b.id)) { keep.add(b.id); all.push(b.id); }
  return { ids: all, save: { v: 1, ids: savedIds, cursor: Math.max(stored?.cursor ?? -1, safeTo) } };
}

export async function getBurnedTokenIds(opts: {
  chain: ArchiveChain;
  nftManager: string;
  wallet: string;
  /** The manager's deploy block: the first block a cold read starts from. */
  fromBlock: number;
  /** For tests: a store with get / set (defaults to the shared store). */
  store?: Store;
  /** For tests: replaces the two sources. */
  sources?: Array<(from: number) => Promise<{ burns: Burn[]; head: number }>>;
}): Promise<BurnedIdsResult> {
  const chain = opts.chain;
  const manager = opts.nftManager.toLowerCase();
  const wallet = opts.wallet.toLowerCase();
  const redis = opts.store !== undefined ? opts.store : sharedRedis;
  const key = `${KEY_PREFIX}${chain}:${manager}:${wallet}`;

  let stored: Stored | null = null;
  let storeRead = !redis; // no store: nothing to protect
  if (redis) {
    try {
      const v = await redis.get(key);
      const parsed = (typeof v === 'string' ? JSON.parse(v) : v) as Stored | null;
      if (parsed && parsed.v === 1 && Array.isArray(parsed.ids) && Number.isFinite(parsed.cursor)) stored = parsed;
      storeRead = true;
    } catch (err) {
      // Read the whole history instead; the result is still complete, but is
      // not written over a saved list this request could not see.
      console.warn(`[evmBurnedNftIds] ${chain}: saved list could not be read (${err instanceof Error ? err.message : 'error'}); reading from the deploy block`);
    }
  }
  const from = Math.max(opts.fromBlock, (stored?.cursor ?? -1) + 1);

  const sources = opts.sources ?? (archiveServesWideLogs(chain)
    ? [(f: number) => burnsFromLogs(chain, manager, wallet, f), (f: number) => burnsFromTransferIndex(chain, manager, wallet, f)]
    : [(f: number) => burnsFromTransferIndex(chain, manager, wallet, f)]);

  let reason: typeof LOOKUP_FAILED | typeof LOOKUP_UNAVAILABLE = LOOKUP_FAILED;
  for (const source of sources) {
    try {
      const { burns, head } = await source(from);
      const { ids, save } = mergeBurns(stored, burns, head, REORG_MARGIN_BLOCKS[chain], opts.fromBlock);
      const grew = save.ids.length > (stored?.ids.length ?? 0) || save.cursor > (stored?.cursor ?? -1);
      if (redis && storeRead && grew) {
        void redis.set(key, JSON.stringify(save)).catch((err: unknown) => {
          console.warn(`[evmBurnedNftIds] ${chain}: save failed (${err instanceof Error ? err.message : 'error'})`);
        });
      }
      return { ids, complete: true, reason: null };
    } catch (err) {
      reason = err instanceof LookupError ? err.reason : LOOKUP_FAILED;
      console.warn(`[evmBurnedNftIds] ${chain}: burn lookup did not complete (${reason}: ${err instanceof Error ? err.message : 'error'})`);
    }
  }
  // Every source failed. What was saved earlier is still the wallet's: returned
  // flagged, never as "burned nothing".
  return { ids: [...(stored?.ids ?? [])], complete: false, reason };
}
