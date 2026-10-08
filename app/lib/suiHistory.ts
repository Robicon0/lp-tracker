// Shared Sui HISTORY source (GraphQL). Every read of a Sui wallet's or object's
// past transactions goes through this module.
//
// WHY THIS EXISTS
// The JSON-RPC endpoints stopped serving history: the public fullnode answers
// "JSON-RPC deprecated", and the configured provider lists every digest but
// returns an empty shell for anything older than about a week — which reads
// exactly like "this transaction emitted no events". Measured on one wallet:
// 347 digests listed, 338 returned as shells, so 22 closed positions and an
// open position's deposit were invisible. `suiRpc.ts` stays the transport for
// LIVE state (owned objects, pool objects); history is read here.
//
// COMPLETENESS IS PROVEN, NOT ASSUMED (rule (a): a short or empty history answer
// is never treated as complete). A wallet scan is `complete` only when
//   1. paging ended with no next page,
//   2. the oldest transaction scanned is the wallet's first transaction, which
//      is asked for separately,
//   3. every transaction with more than one page of events had the rest fetched,
// and no request failed on the way. The fourth check — positions opened minus
// positions closed equals the position objects the wallet owns now — needs
// per-protocol event knowledge and lives with the caller (suiClosedPositions).
//
// THE SCAN IS INCREMENTAL. Finalized history is immutable, so the position
// events found for a wallet are stored once (no expiry) with the checkpoint the
// scan reached; the next load only asks for transactions from that checkpoint
// on. A position closed today is therefore seen today, for one small request.
// A short or failed scan is never written — the stored events are returned with
// `complete: false`.
//
// SENDER FILTER. The wallet scan lists transactions the wallet SENT. The wider
// "affected address" filter was measured and rejected: it adds transactions sent
// by others (27 for the measured wallet, two of them aggregator swaps carrying
// other users' pool events), which would attribute strangers' activity to this
// wallet. A position the wallet did not open itself is instead completed from
// the position OBJECT's own history (`getSuiObjectHistory`), which is exact
// regardless of who signed. What stays out of reach is a position that was
// opened AND closed entirely by other senders — nothing ties it to the wallet.

import { Redis } from '@upstash/redis';
import { rpcUrlFromEnv } from './rpcEnv';

const DEFAULT_ENDPOINT = 'https://graphql.mainnet.sui.io/graphql';
function endpoint(): string { return rpcUrlFromEnv('SUI_GRAPHQL_URL') || DEFAULT_ENDPOINT; }

// Service limits (serviceConfig, measured): 300 query nodes, 5,000-byte query,
// 40 s timeout. Queries here are a few hundred bytes and a dozen nodes.
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 4;
const MAX_CONCURRENT = 4;
const TX_PAGE = 50;
const EVENT_PAGE = 50;
const MAX_TX_PAGES = 200; // 10,000 transactions; hitting it marks the scan short

export class SuiHistoryUnavailableError extends Error {
  constructor(reason: string) { super(`sui-history-unavailable: ${reason}`); this.name = 'SuiHistoryUnavailableError'; }
}

// ── Paced transport ──────────────────────────────────────────────────────────
let active = 0;
const waiters: Array<() => void> = [];
async function acquire<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiters.push(r));
  active += 1;
  try { return await fn(); } finally { active -= 1; waiters.shift()?.(); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One GraphQL call. Retries throttling, 5xx, timeouts and data-less errors; throws when it cannot answer. */
async function gql<T>(query: string): Promise<T> {
  return acquire(async () => {
    let last = 'no attempt';
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(400 * 2 ** (attempt - 1));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(endpoint(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query }),
          signal: controller.signal,
          cache: 'no-store',
        });
        if (res.status === 429 || res.status >= 500) {
          last = `http ${res.status}`;
          const retryAfter = Number(res.headers.get('retry-after'));
          if (Number.isFinite(retryAfter) && retryAfter > 0) await sleep(Math.min(retryAfter, 5) * 1000);
          continue;
        }
        const json = (await res.json()) as { data?: T | null; errors?: Array<{ message?: string }> };
        if (json.data && !json.errors?.length) return json.data;
        last = json.errors?.[0]?.message?.slice(0, 160) ?? `http ${res.status} without data`;
        // A validation error is deterministic — retrying cannot help.
        if (res.status === 400 || /VALIDATION|parse|Unknown (field|argument)/i.test(last)) break;
      } catch (err) {
        last = (err as Error)?.name === 'AbortError' ? 'timeout' : String(err).slice(0, 120);
      } finally {
        clearTimeout(timer);
      }
    }
    throw new SuiHistoryUnavailableError(last);
  });
}

// ── Shapes ───────────────────────────────────────────────────────────────────
/** Same shape the JSON-RPC parsers already consume, so they run unchanged. */
export interface SuiHistoryBlock {
  digest: string;
  timestampMs: string;
  events: Array<{ type: string; parsedJson: Record<string, unknown> }>;
}

interface GqlEvent { contents?: { type?: { repr?: string }; json?: unknown } | null }
interface GqlEvents { pageInfo: { hasNextPage: boolean; endCursor?: string | null }; nodes: GqlEvent[] }
interface GqlTx {
  digest: string;
  effects?: { status?: string; timestamp?: string; checkpoint?: { sequenceNumber?: number } | null; events?: GqlEvents | null } | null;
}
interface GqlTxPage { pageInfo: { hasNextPage: boolean; endCursor?: string | null }; nodes: GqlTx[] }

const TX_FIELDS =
  `digest effects{ status timestamp checkpoint{ sequenceNumber } ` +
  `events(first:${EVENT_PAGE}){ pageInfo{ hasNextPage endCursor } nodes{ contents{ type{ repr } json } } } }`;

// The packages whose events describe a liquidity position. Only these are kept
// (a wallet's swaps and oracle updates are many times larger and never read).
// A new Sui CLMM protocol adds its package here.
const POSITION_EVENT_PACKAGES = [
  '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb', // Cetus (fees / lifecycle)
  '0xdb5cd62a06c79695bfc9982eb08534706d3752fe123b48e0144f480209b3117f', // Cetus (V2 deposits / withdrawals)
  '0xdc67d6de3f00051c505da10d8f6fbab3b3ec21ec65f0dc22a2f36c13fc102110', // Cetus (V2 rewards)
  '0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267', // Bluefin
  '0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860', // Momentum
];
function isPositionEvent(type: string): boolean {
  if (!POSITION_EVENT_PACKAGES.some((p) => type.startsWith(p))) return false;
  const name = type.replace(/<.*/, '').split('::').pop() ?? '';
  return !/Swap|FlashLoan|Flash/i.test(name);
}

// GraphQL renders a Move `TypeName` as a plain string where JSON-RPC rendered
// `{ name }`. The parsers read `.name`, so the two fields that carry one are
// restored to the shape they expect. Everything else is identical between the
// two sources (verified field by field on live transactions).
const TYPE_NAME_FIELDS = ['rewarder_type', 'reward_coin_type'];
function toParsedJson(json: unknown): Record<string, unknown> {
  if (!json || typeof json !== 'object') return {};
  const out = { ...(json as Record<string, unknown>) };
  for (const f of TYPE_NAME_FIELDS) if (typeof out[f] === 'string') out[f] = { name: out[f] };
  return out;
}

async function restOfEvents(digest: string, after: string | null | undefined): Promise<GqlEvent[]> {
  const out: GqlEvent[] = [];
  let cursor = after ?? null;
  for (let guard = 0; guard < 200 && cursor; guard++) {
    const d = await gql<{ transaction: { effects: { events: GqlEvents } | null } | null }>(
      `{ transaction(digest:"${digest}"){ effects{ events(first:${EVENT_PAGE}, after:"${cursor}"){ pageInfo{ hasNextPage endCursor } nodes{ contents{ type{ repr } json } } } } } }`,
    );
    const ev = d.transaction?.effects?.events;
    if (!ev) throw new SuiHistoryUnavailableError(`event page missing for ${digest}`);
    out.push(...ev.nodes);
    cursor = ev.pageInfo.hasNextPage ? (ev.pageInfo.endCursor ?? null) : null;
  }
  if (cursor) throw new SuiHistoryUnavailableError(`event paging did not end for ${digest}`);
  return out;
}

/** A transaction as a parser block holding only its position events, or null when it has none. */
async function toBlock(tx: GqlTx): Promise<SuiHistoryBlock | null> {
  const eff = tx.effects;
  if (!eff?.timestamp) throw new SuiHistoryUnavailableError(`transaction ${tx.digest} returned without details`);
  if (eff.status !== 'SUCCESS') return null;
  const nodes = [...(eff.events?.nodes ?? [])];
  if (eff.events?.pageInfo.hasNextPage) nodes.push(...(await restOfEvents(tx.digest, eff.events.pageInfo.endCursor)));
  const events: SuiHistoryBlock['events'] = [];
  for (const n of nodes) {
    const type = n.contents?.type?.repr;
    if (!type || !isPositionEvent(type)) continue;
    events.push({ type, parsedJson: toParsedJson(n.contents?.json) });
  }
  if (events.length === 0) return null;
  return { digest: tx.digest, timestampMs: String(Date.parse(eff.timestamp)), events };
}

// ── Stored wallet history ────────────────────────────────────────────────────
interface StoredHistory {
  v: 1;
  /** The wallet's first transaction (null = the wallet has sent none). */
  firstDigest: string | null;
  /** Checkpoint of the newest transaction scanned (or the chain head when none). */
  lastCheckpoint: number;
  /** Digests already counted at `lastCheckpoint`, so the overlap is not double counted. */
  tailDigests: string[];
  txCount: number;
  blocks: SuiHistoryBlock[];
}

const _url = process.env.PRICE_CACHE_KV_REST_API_URL;
const _token = process.env.PRICE_CACHE_KV_REST_API_TOKEN;
let _redis: Redis | null = null;
if (_url && _token) {
  try { _redis = new Redis({ url: _url, token: _token }); }
  catch (err) { console.warn('[suiHistory] Redis client construction failed; no-op stub:', err); _redis = null; }
}
// The store is shared with production: a local run must not write to it.
const readOnly = () => process.env.CLOSED_POS_CACHE_READONLY === '1';
const historyKey = (wallet: string) => `sui_wallet_hist_v1:${wallet.toLowerCase()}`;

interface HistoryStore { get(key: string): Promise<unknown>; set(key: string, value: string): Promise<unknown> }
let _store: HistoryStore | null = _redis
  ? { get: (k) => _redis!.get(k), set: (k, v) => _redis!.set(k, v) }
  : null;

async function readStored(wallet: string): Promise<StoredHistory | null> {
  if (!_store) return null;
  try {
    const raw = (await _store.get(historyKey(wallet))) as StoredHistory | string | null;
    const v = typeof raw === 'string' ? (JSON.parse(raw) as StoredHistory) : raw;
    if (v && v.v === 1 && Array.isArray(v.blocks) && typeof v.lastCheckpoint === 'number') return v;
    return null;
  } catch { return null; }
}
function writeStored(wallet: string, value: StoredHistory): void {
  if (!_store || readOnly()) return;
  _store.set(historyKey(wallet), JSON.stringify(value))
    .catch((err) => console.warn('[suiHistory] Redis write failed (ignored):', String(err).slice(0, 160)));
}

export interface SuiWalletHistory {
  /** Transactions the wallet sent that carry position events, oldest first. */
  blocks: SuiHistoryBlock[];
  /** False when the scan could not be shown to cover the wallet's whole history. */
  complete: boolean;
  /** Why it is short (for logs and the notice), when `complete` is false. */
  reason?: string;
  /** Changes whenever the stored history gains a transaction with position events. */
  mark: string;
  txCount: number;
}

const markOf = (blocks: SuiHistoryBlock[]) => `${blocks.length}:${blocks[blocks.length - 1]?.digest ?? '-'}`;

async function scanWallet(wallet: string): Promise<SuiWalletHistory> {
  const stored = await readStored(wallet);
  const short = (reason: string): SuiWalletHistory => ({
    blocks: stored?.blocks ?? [], complete: false, reason, mark: markOf(stored?.blocks ?? []), txCount: stored?.txCount ?? 0,
  });

  try {
    const run = async (from: StoredHistory | null): Promise<SuiWalletHistory> => {
      const filter = from
        ? `{sentAddress:"${wallet}", afterCheckpoint:${Math.max(0, from.lastCheckpoint - 1)}}`
        : `{sentAddress:"${wallet}"}`;
      const seen = new Set(from?.tailDigests ?? []);
      const fresh: GqlTx[] = [];
      let firstDigest: string | null = null;
      let head = 0;
      let cursor: string | null = null;
      let ended = false;
      for (let page = 0; page < MAX_TX_PAGES; page++) {
        const after: string = cursor ? `, after:"${cursor}"` : '';
        // The first request also asks, separately, for the wallet's first
        // transaction and the chain head.
        const extra: string = page === 0
          ? ` first: transactions(first:1, filter:{sentAddress:"${wallet}"}){ nodes{ digest } } head: checkpoint{ sequenceNumber }`
          : '';
        const d = await gql<{ page: GqlTxPage; first?: { nodes: Array<{ digest: string }> }; head?: { sequenceNumber: number } }>(
          `{ page: transactions(first:${TX_PAGE}${after}, filter:${filter}){ pageInfo{ hasNextPage endCursor } nodes{ ${TX_FIELDS} } }${extra} }`,
        );
        if (page === 0) { firstDigest = d.first?.nodes?.[0]?.digest ?? null; head = d.head?.sequenceNumber ?? 0; }
        for (const tx of d.page.nodes) { if (!seen.has(tx.digest)) { seen.add(tx.digest); fresh.push(tx); } }
        if (!d.page.pageInfo.hasNextPage) { ended = true; break; }
        cursor = d.page.pageInfo.endCursor ?? null;
        if (!cursor) break;
      }
      if (!ended) return short('paging did not end');                              // check 1

      // check 2 — the oldest transaction we hold must be the wallet's first.
      const oldest = from ? from.firstDigest : (fresh[0]?.digest ?? null);
      if (oldest !== firstDigest) {
        if (from) return run(null); // stored history does not start where the chain says: rebuild
        return short('oldest scanned transaction is not the wallet\'s first');
      }

      // check 3 inside toBlock (extra event pages; paced by the transport semaphore)
      const newBlocks = (await Promise.all(fresh.map(toBlock))).filter((b): b is SuiHistoryBlock => b !== null);
      const blocks = [...(from?.blocks ?? []), ...newBlocks];

      let lastCheckpoint = from?.lastCheckpoint ?? head;
      let tailDigests = from?.tailDigests ?? [];
      const newest = fresh[fresh.length - 1]?.effects?.checkpoint?.sequenceNumber;
      if (typeof newest === 'number' && newest >= lastCheckpoint) {
        const atNewest = fresh.filter((t) => t.effects?.checkpoint?.sequenceNumber === newest).map((t) => t.digest);
        tailDigests = newest === lastCheckpoint ? [...new Set([...tailDigests, ...atNewest])] : atNewest;
        lastCheckpoint = newest;
      }
      const txCount = (from?.txCount ?? 0) + fresh.length;
      if (!from || fresh.length > 0) writeStored(wallet, { v: 1, firstDigest, lastCheckpoint, tailDigests, txCount, blocks });
      return { blocks, complete: true, mark: markOf(blocks), txCount };
    };
    return await run(stored);
  } catch (err) {
    return short(err instanceof SuiHistoryUnavailableError ? err.message : String(err).slice(0, 160));
  }
}

// One scan per wallet per instance at a time, and a short memo so the closed
// scan, the three fee scans and any effect re-run share ONE result.
const MEMO_MS = 30_000;
// `doneAt` is null while the scan is in flight: an in-flight scan is always
// shared, and the freshness window starts when it FINISHES (a first scan can
// take longer than the window itself).
interface Memo<T> { doneAt: number | null; p: Promise<T> }
const memoFresh = <T>(m: Memo<T> | undefined): m is Memo<T> => !!m && (m.doneAt === null || Date.now() - m.doneAt < MEMO_MS);
const _walletMemo = new Map<string, Memo<SuiWalletHistory>>();

/**
 * The wallet's position-event history, extended from where the last scan
 * stopped. Never throws: a failed or short scan returns the stored events with
 * `complete: false`.
 */
export function getSuiWalletHistory(wallet: string): Promise<SuiWalletHistory> {
  const key = wallet.toLowerCase();
  const hit = _walletMemo.get(key);
  if (memoFresh(hit)) return hit.p;
  const p = scanWallet(wallet);
  const memo: Memo<SuiWalletHistory> = { doneAt: null, p };
  _walletMemo.set(key, memo);
  // A short result is not held: the next caller tries again.
  p.then(
    (r) => { if (_walletMemo.get(key) !== memo) return; if (r.complete) memo.doneAt = Date.now(); else _walletMemo.delete(key); },
    () => { if (_walletMemo.get(key) === memo) _walletMemo.delete(key); },
  );
  return p;
}

const _objectMemo = new Map<string, Memo<SuiHistoryBlock[]>>();

/**
 * Every transaction that touched one object (a position), whoever signed it.
 * Exact for a single position and independent of the wallet scan. THROWS when
 * the history cannot be read in full — an incomplete answer here must never
 * read as "this position has no deposits".
 */
export function getSuiObjectHistory(objectId: string): Promise<SuiHistoryBlock[]> {
  const key = objectId.toLowerCase();
  const hit = _objectMemo.get(key);
  if (memoFresh(hit)) return hit.p;
  const p = (async () => {
    const blocks: SuiHistoryBlock[] = [];
    let cursor: string | null = null;
    let ended = false;
    for (let page = 0; page < MAX_TX_PAGES; page++) {
      const after: string = cursor ? `, after:"${cursor}"` : '';
      const d = await gql<{ page: GqlTxPage }>(
        `{ page: transactions(first:${TX_PAGE}${after}, filter:{affectedObject:"${objectId}"}){ pageInfo{ hasNextPage endCursor } nodes{ ${TX_FIELDS} } } }`,
      );
      for (const b of await Promise.all(d.page.nodes.map(toBlock))) if (b) blocks.push(b);
      if (!d.page.pageInfo.hasNextPage) { ended = true; break; }
      cursor = d.page.pageInfo.endCursor ?? null;
      if (!cursor) break;
    }
    if (!ended) throw new SuiHistoryUnavailableError(`paging did not end for object ${objectId}`);
    return blocks;
  })();
  const memo: Memo<SuiHistoryBlock[]> = { doneAt: null, p };
  _objectMemo.set(key, memo);
  p.then(() => { memo.doneAt = Date.now(); }, () => { if (_objectMemo.get(key) === memo) _objectMemo.delete(key); });
  return p;
}

/** Object ids of one type the wallet owns NOW. Throws rather than return a partial set. */
export async function getSuiOwnedObjectIds(wallet: string, type: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 200; page++) {
    const after: string = cursor ? `, after:"${cursor}"` : '';
    const d = await gql<{ address: { objects: { pageInfo: { hasNextPage: boolean; endCursor?: string | null }; nodes: Array<{ address: string }> } } | null }>(
      `{ address(address:"${wallet}"){ objects(first:50${after}, filter:{type:"${type}"}){ pageInfo{ hasNextPage endCursor } nodes{ address } } } }`,
    );
    const o = d.address?.objects;
    if (!o) return ids; // an address with no objects at all
    for (const n of o.nodes) ids.add(n.address);
    if (!o.pageInfo.hasNextPage) return ids;
    cursor = o.pageInfo.endCursor ?? null;
    if (!cursor) break;
  }
  throw new SuiHistoryUnavailableError('owned-object paging did not end');
}

/**
 * A coin's symbol and decimals from the chain's CoinMetadata. Returns null when
 * the coin has none or the read fails — the caller must treat that as "unknown",
 * never as a number.
 */
export async function getSuiCoinMetadata(coinType: string): Promise<{ symbol: string | null; decimals: number | null } | null> {
  try {
    const d = await gql<{ coinMetadata: { symbol?: string | null; decimals?: number | null } | null }>(
      `{ coinMetadata(coinType:"${coinType}"){ symbol decimals } }`,
    );
    const m = d.coinMetadata;
    if (!m) return null;
    return { symbol: typeof m.symbol === 'string' ? m.symbol : null, decimals: typeof m.decimals === 'number' ? m.decimals : null };
  } catch {
    return null;
  }
}

/** Merge transaction lists by digest, oldest first. */
export function mergeSuiBlocks(...lists: SuiHistoryBlock[][]): SuiHistoryBlock[] {
  const byDigest = new Map<string, SuiHistoryBlock>();
  for (const list of lists) for (const b of list) if (!byDigest.has(b.digest)) byDigest.set(b.digest, b);
  return [...byDigest.values()].sort((a, b) => Number(a.timestampMs) - Number(b.timestampMs));
}

export interface SuiActivityBlocks { blocks: SuiHistoryBlock[]; complete: boolean }

/**
 * The transactions an activity route parses.
 *
 *  - Wallet scope (`positionId` null): the wallet's own position history. Never
 *    throws; `complete: false` means it may be missing transactions and the
 *    route must say so.
 *  - One position: that position OBJECT's history — exact whoever signed, so a
 *    position opened through a router or received by transfer still has its
 *    deposit — plus the wallet's own history. THROWS when the object history
 *    cannot be read in full: the caller answers 500 and the page falls back to
 *    last-known values, rather than reporting a position with no deposits.
 */
export async function getSuiActivityBlocks(wallet: string, positionId: string | null): Promise<SuiActivityBlocks> {
  if (!positionId) {
    const h = await getSuiWalletHistory(wallet);
    return { blocks: h.blocks, complete: h.complete };
  }
  const [obj, h] = await Promise.all([getSuiObjectHistory(positionId), getSuiWalletHistory(wallet)]);
  return { blocks: mergeSuiBlocks(obj, h.blocks), complete: true };
}

/** Tests only: swap the store (e.g. for an in-memory one) and forget memoized scans. */
export function _setSuiHistoryStoreForTests(store: HistoryStore | null): void {
  _store = store;
  _walletMemo.clear();
  _objectMemo.clear();
}
