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
// THE SCAN IS RESUMABLE AND TIME-BUDGETED (app/lib/historyScan.ts). History is
// read newest first, 50 transactions a page; the cursor and the position events
// found so far are stored after every few pages. A request spends at most its
// time budget, then returns what it has flagged incomplete, and the next request
// carries on from the cursor. Finalized history is immutable, so once the first
// pass has reached the wallet's first transaction a load only asks for what is
// newer than the stored head: a position closed today is seen today, for one
// small request. A history longer than the limits below is CAPPED: the most
// recent part is kept and the result stays flagged for good.
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
import { runResumableScan, readStoredScan, _resetHistoryScanOverlay, type ScanSource, type ScanStatus, type ScanStore } from './historyScan';

const DEFAULT_ENDPOINT = 'https://graphql.mainnet.sui.io/graphql';
function endpoint(): string { return rpcUrlFromEnv('SUI_GRAPHQL_URL') || DEFAULT_ENDPOINT; }

// Service limits (serviceConfig, measured): 300 query nodes, 5,000-byte query,
// 40 s timeout. Queries here are a few hundred bytes and a dozen nodes.
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 4;
const MAX_CONCURRENT = 4;
const TX_PAGE = 50;
const EVENT_PAGE = 50;
const MAX_TX_PAGES = 200; // object history only: 10,000 transactions; hitting it throws
// Wallet-scan limits. Past either one the first pass stops and the history is
// reported capped (most recent part kept).
export const SUI_MAX_SCANNED_TX = 30_000;
export const SUI_MAX_KEPT_TX = 4_000;

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
interface GqlTxPageBack { pageInfo: { hasPreviousPage: boolean; startCursor?: string | null }; nodes: GqlTx[] }

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
const _url = process.env.PRICE_CACHE_KV_REST_API_URL;
const _token = process.env.PRICE_CACHE_KV_REST_API_TOKEN;
let _redis: Redis | null = null;
if (_url && _token) {
  try { _redis = new Redis({ url: _url, token: _token }); }
  catch (err) { console.warn('[suiHistory] Redis client construction failed; no-op stub:', err); _redis = null; }
}
// v2: resumable layout (a meta key plus chunk keys). v1 held one finished scan
// in a single value and is no longer read.
const historyKey = (wallet: string) => `sui_wallet_hist_v2:${wallet.toLowerCase()}`;

let _store: ScanStore | null = _redis
  ? {
      get: (k) => _redis!.get(k),
      mget: (keys) => (keys.length ? _redis!.mget(...keys) : Promise.resolve([])),
      set: (k, v, o) => (o ? _redis!.set(k, v, { ...(o.nx ? { nx: true as const } : {}), ...(o.ex ? { ex: o.ex } : {}) } as never) : _redis!.set(k, v)),
      del: (k) => _redis!.del(k),
    }
  : null;

export interface SuiWalletHistory {
  /** Transactions the wallet sent that carry position events, oldest first. */
  blocks: SuiHistoryBlock[];
  /** False when the scan could not be shown to cover the wallet's whole history. */
  complete: boolean;
  /** `in-progress`: more arrives on the next load. `capped`: the history is larger than the limit. */
  status: ScanStatus;
  /** Why it is short (for logs and the notice), when `complete` is false. */
  reason?: string;
  /** Changes whenever the stored history gains a transaction or its completeness changes. */
  mark: string;
  /** Transactions examined so far. */
  txCount: number;
}

/** Cursor of the next (older) page, with the oldest digest seen so far for the end check. */
interface SuiCursor { c: string; o: string | null }

function walletSource(wallet: string): ScanSource<SuiHistoryBlock, SuiCursor> {
  return {
    async page({ until, cursor }) {
      // `until` is the checkpoint an earlier segment already covered; this one
      // reads strictly after it. The first page also reads the chain head, which
      // becomes the next segment's `until`.
      const filter = `{sentAddress:"${wallet}"${until !== null ? `, afterCheckpoint:${until}` : ''}}`;
      const before = cursor ? `, before:"${cursor.c}"` : '';
      const extra = cursor ? '' : ' head: checkpoint{ sequenceNumber }';
      const d = await gql<{ page: GqlTxPageBack; head?: { sequenceNumber: number } }>(
        `{ page: transactions(last:${TX_PAGE}${before}, filter:${filter}){ pageInfo{ hasPreviousPage startCursor } nodes{ ${TX_FIELDS} } }${extra} }`,
      );
      const nodes = d.page.nodes; // oldest first within the page
      // check 3 (extra event pages) inside toBlock; a transaction returned
      // without its details throws and the page is retried on the next load.
      const items = (await Promise.all(nodes.map(toBlock))).filter((b): b is SuiHistoryBlock => b !== null);
      let top: string | null = null;
      if (!cursor) {
        let hi = d.head?.sequenceNumber ?? 0;
        for (const n of nodes) hi = Math.max(hi, n.effects?.checkpoint?.sequenceNumber ?? 0);
        if (!(hi > 0)) throw new SuiHistoryUnavailableError('chain head not returned');
        top = String(hi);
      }
      const oldest = nodes[0]?.digest ?? cursor?.o ?? null;
      const ended = !d.page.pageInfo.hasPreviousPage;
      if (ended && until === null) {
        // check 2 — the first pass ends at the wallet's FIRST transaction, which
        // is asked for separately. Anything else means the provider cut the list.
        const f = await gql<{ first: { nodes: Array<{ digest: string }> } }>(
          `{ first: transactions(first:1, filter:{sentAddress:"${wallet}"}){ nodes{ digest } } }`,
        );
        const firstDigest = f.first?.nodes?.[0]?.digest ?? null;
        if (firstDigest !== oldest) throw new SuiHistoryUnavailableError('oldest scanned transaction is not the wallet\'s first');
      }
      const start = d.page.pageInfo.startCursor ?? null;
      if (!ended && !start) throw new SuiHistoryUnavailableError('page cursor missing');   // check 1
      return { items, scanned: nodes.length, top, next: ended ? null : { c: start!, o: oldest } };
    },
  };
}

/**
 * The wallet's position-event history, advanced by one time budget from where
 * the last request stopped. Never throws: an unfinished, capped or failed scan
 * returns what is stored with `complete: false` and a `status` saying which.
 */
export async function getSuiWalletHistory(wallet: string): Promise<SuiWalletHistory> {
  const r = await runResumableScan<SuiHistoryBlock, SuiCursor>({
    key: historyKey(wallet),
    store: _store,
    source: walletSource(wallet),
    idOf: (b) => b.digest,
    maxScanned: SUI_MAX_SCANNED_TX,
    maxKept: SUI_MAX_KEPT_TX,
    log: (m) => console.warn(`[suiHistory] ${m}`),
  });
  let blocks: SuiHistoryBlock[] = [];
  let failed: string | null = null;
  try { blocks = await r.items(); } catch (err) { failed = String(err).slice(0, 160); }
  if (failed) return { blocks: [], complete: false, status: 'failed', reason: failed, mark: '0:failed', txCount: r.scanned };
  return { blocks, complete: r.complete, status: r.status, reason: r.reason, mark: r.mark, txCount: r.scanned };
}

/** What is stored for the wallet right now, without scanning. For callers that must not wait. */
export async function getStoredSuiWalletBlocks(wallet: string): Promise<SuiHistoryBlock[]> {
  return (await readStoredScan<SuiHistoryBlock>(historyKey(wallet), _store, (b) => b.digest)).items;
}

interface Memo<T> { doneAt: number | null; p: Promise<T> }
const MEMO_MS = 30_000;
const memoFresh = <T>(m: Memo<T> | undefined): m is Memo<T> => !!m && (m.doneAt === null || Date.now() - m.doneAt < MEMO_MS);
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

export interface SuiActivityBlocks { blocks: SuiHistoryBlock[]; complete: boolean; status: ScanStatus }

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
    return { blocks: h.blocks, complete: h.complete, status: h.status };
  }
  // The object's own history is exact and complete by itself. The wallet's
  // stored history is merged in as it stands: an open position's page must
  // never wait for a long wallet scan.
  const [obj, stored] = await Promise.all([getSuiObjectHistory(positionId), getStoredSuiWalletBlocks(wallet)]);
  return { blocks: mergeSuiBlocks(obj, stored), complete: true, status: 'complete' };
}

/** Tests only: swap the store (e.g. for an in-memory one) and forget memoized scans. */
export function _setSuiHistoryStoreForTests(store: ScanStore | null): void {
  _store = store;
  _resetHistoryScanOverlay();
  _objectMemo.clear();
}
