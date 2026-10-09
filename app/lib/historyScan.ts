// Resumable, time-budgeted history scan — ONE engine for every chain.
//
// A wallet's history is read in pages. Three things used to go wrong when a scan
// was written as "fetch every page, then decide":
//
//   * a long history ran past the page cap or the server time limit, the whole
//     scan was thrown away, and the next load started again from zero;
//   * until the last page arrived there was nothing to show (all-or-nothing);
//   * a wallet too large to finish never produced a result at all.
//
// This engine owns the fix for all three, for any chain:
//
//   1. PROGRESS IS STORED PER PAGE. The cursor and everything kept so far live in
//      the store, so an interrupted, failed or capped scan resumes where it
//      stopped — on the next request, on any instance.
//   2. EVERY REQUEST HAS A TIME BUDGET. When it runs out the scan stops cleanly
//      and returns what it has, flagged `in-progress`. The next request continues.
//   3. PARTIAL RESULTS ARE FLAGGED, NEVER SILENT. `complete` is true only when the
//      first pass reached the start of the history AND this request caught up to
//      the newest transaction. A capped history stays flagged for good.
//
// History is read NEWEST FIRST. A segment starts at the newest transaction and
// pages back until it meets `until` — the newest point an earlier segment
// already covered (null on the very first pass: page back to the wallet's first
// transaction). Reading newest-first means a partial or capped result holds the
// RECENT history, which is what a user looks at first, and that "what is new
// since last time" is the same code path as the first pass.
//
// The chain adapter supplies only `page()`. No chain imports here on purpose:
// the test script loads this file directly under Node.

export interface ScanStore {
  get(key: string): Promise<unknown>;
  mget(keys: string[]): Promise<unknown[]>;
  /** With `nx`, resolves to a falsy value when the key already exists. */
  set(key: string, value: string, opts?: { nx?: boolean; ex?: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export interface ScanPage<T, C> {
  /** Kept records from this page, OLDEST FIRST. */
  items: T[];
  /** How many transactions the page examined (kept or not). */
  scanned: number;
  /** The newest point this segment covers. Read from the segment's first page. */
  top?: string | null;
  /** Cursor for the next (older) page, or null when the segment reached its end. */
  next: C | null;
}

export interface ScanSource<T, C> {
  /**
   * `deadlineMs` is when this request's budget ends. A page that cannot finish
   * reasonably soon after it should throw: the pages before it are kept and the
   * request returns, instead of one slow page holding the request open.
   */
  page(args: { until: string | null; cursor: C | null; deadlineMs: number }): Promise<ScanPage<T, C>>;
}

interface Segment<C> { until: string | null; top: string | null; cursor: C | null; pages: number; no: number }

export type ScanCap = 'scanned' | 'kept' | 'store';

export interface ScanMeta<C> {
  v: 1;
  /** Newest point covered by finished segments. */
  head: string | null;
  seg: Segment<C> | null;
  /** The first pass ended (at the wallet's first transaction, or at a cap). */
  backfillDone: boolean;
  capped: ScanCap | null;
  scanned: number;
  kept: number;
  /** Byte size of each stored chunk. */
  chunks: number[];
  segNo: number;
  updatedAt: number;
}

export type ScanStatus = 'complete' | 'in-progress' | 'capped' | 'failed';

export interface ScanResult<T> {
  status: ScanStatus;
  complete: boolean;
  reason?: string;
  scanned: number;
  kept: number;
  /** Changes whenever the kept set or its completeness changes. */
  mark: string;
  /** Everything kept so far, oldest first, de-duplicated by id. */
  items(): Promise<T[]>;
}

export interface ScanOptions<T, C> {
  key: string;
  store: ScanStore | null;
  source: ScanSource<T, C>;
  idOf: (item: T) => string;
  /** Wall-clock budget for this request. */
  budgetMs?: number;
  /** First pass stops (capped) after examining this many transactions. */
  maxScanned: number;
  /** First pass stops (capped) after keeping this many records. */
  maxKept: number;
  /** Nothing is kept past this total, first pass or later. */
  maxKeptTotal?: number;
  /** How long to wait when another request holds the scan, before serving what is stored. */
  lockWaitMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

export const HISTORY_SCAN_DEFAULT_BUDGET_MS = 40_000;
const CHUNK_TARGET_BYTES = 450_000;
const CHUNK_MAX_BYTES = 850_000;
const PERSIST_EVERY_PAGES = 8;
const PERSIST_EVERY_ITEMS = 250;
const LOCK_SECONDS = 120;
const LOCK_WAIT_MS = 3_000;
const MEMO_MS = 30_000;
/** Order stamp: later segments are newer; within a segment later pages are older. */
const orderOf = (segNo: number, page: number, idx: number) => segNo * 1e8 - page * 1e4 + idx;

type Entry<T> = [number, T];

/** Test knobs, shared with closedPositionCache: a local run must not write to the shared store. */
function envReadOnly(): boolean {
  return typeof process !== 'undefined' && process.env?.CLOSED_POS_CACHE_READONLY === '1';
}
export function historyScanBudgetMs(): number {
  const raw = typeof process !== 'undefined' ? process.env?.HISTORY_SCAN_BUDGET_MS : undefined;
  const n = raw == null || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : HISTORY_SCAN_DEFAULT_BUDGET_MS;
}

// In read-only mode writes go to this process-local overlay instead of the
// store, so a local run still resumes across requests without touching the
// shared database. Reads fall through to the store for keys never written here.
const _overlay = new Map<string, string | null>();
function overlayStore(base: ScanStore | null): ScanStore {
  return {
    async get(k) { return _overlay.has(k) ? _overlay.get(k) : (base ? base.get(k) : null); },
    async mget(keys) {
      const miss = keys.filter((k) => !_overlay.has(k));
      const fetched = miss.length && base ? await base.mget(miss) : [];
      const byKey = new Map(miss.map((k, i) => [k, fetched[i] ?? null] as const));
      return keys.map((k) => (_overlay.has(k) ? _overlay.get(k) : byKey.get(k) ?? null));
    },
    async set(k, v, o) { if (o?.nx && _overlay.get(k) != null) return null; _overlay.set(k, v); return 'OK'; },
    async del(k) { _overlay.set(k, null); return 1; },
  };
}
/** Test helper: forget everything the read-only overlay holds. */
export function _resetHistoryScanOverlay(): void { _overlay.clear(); _memo.clear(); }

function parse<V>(raw: unknown): V | null {
  if (raw == null) return null;
  if (typeof raw === 'string') { try { return JSON.parse(raw) as V; } catch { return null; } }
  return raw as V;
}

const chunkKey = (key: string, i: number) => `${key}:c${i}`;
const emptyMeta = <C>(): ScanMeta<C> => ({
  v: 1, head: null, seg: null, backfillDone: false, capped: null, scanned: 0, kept: 0, chunks: [], segNo: 0, updatedAt: 0,
});

function statusOf<C>(m: ScanMeta<C>, failed: boolean): ScanStatus {
  if (failed) return 'failed';
  if (!m.backfillDone || m.seg) return 'in-progress';
  return m.capped ? 'capped' : 'complete';
}
const markOf = <C>(m: ScanMeta<C>, status: ScanStatus) => `${m.kept}:${status}`;

const CAP_REASON: Record<ScanCap, string> = {
  scanned: 'history is longer than the scan limit; only the most recent part was read',
  kept: 'history holds more activity than the limit; only the most recent part was kept',
  store: 'history store is full; newer activity is not being added',
};

async function runScan<T, C>(opts: ScanOptions<T, C>): Promise<ScanResult<T>> {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const t0 = now();
  const budget = opts.budgetMs ?? historyScanBudgetMs();
  const store: ScanStore | null = envReadOnly() ? overlayStore(opts.store) : opts.store;
  const maxKeptTotal = opts.maxKeptTotal ?? opts.maxKept * 3;

  let meta: ScanMeta<C> = emptyMeta<C>();
  if (store) {
    try {
      const m = parse<ScanMeta<C>>(await store.get(opts.key));
      if (m && m.v === 1 && Array.isArray(m.chunks)) meta = m;
    } catch { /* a failed read is a miss: scan from the start, nothing is overwritten below */ }
  }

  const loadEntries = async (m: ScanMeta<C>): Promise<Entry<T>[]> => {
    if (!store || m.chunks.length === 0) return [];
    const raw = await store.mget(m.chunks.map((_, i) => chunkKey(opts.key, i)));
    const out: Entry<T>[] = [];
    raw.forEach((r, i) => {
      const arr = parse<Entry<T>[]>(r);
      if (!Array.isArray(arr)) throw new Error(`history chunk ${i} of ${m.chunks.length} is missing`);
      out.push(...arr);
    });
    return out;
  };

  const result = (m: ScanMeta<C>, failed: boolean, reason: string | undefined, fresh: Entry<T>[]): ScanResult<T> => {
    const status = statusOf(m, failed);
    let cache: Promise<T[]> | null = null;
    return {
      status, complete: status === 'complete', scanned: m.scanned, kept: m.kept, mark: markOf(m, status),
      reason: reason ?? (status === 'capped' && m.capped ? CAP_REASON[m.capped] : status === 'in-progress' ? 'history scan still running' : undefined),
      items: () => (cache ??= (async () => {
        // `fresh` are entries this request could not store (no store configured).
        const entries = [...(await loadEntries(m)), ...fresh].sort((a, b) => a[0] - b[0]);
        const seen = new Set<string>();
        const out: T[] = [];
        for (const [, it] of entries) { const id = opts.idOf(it); if (!seen.has(id)) { seen.add(id); out.push(it); } }
        return out;
      })()),
    };
  };

  // One scan per wallet at a time across instances. Whoever does not hold the
  // lock serves what is stored and says the scan is still running.
  const lockKey = `${opts.key}:lock`;
  if (store) {
    let got: unknown = 'OK';
    try { got = await store.set(lockKey, String(t0), { nx: true, ex: LOCK_SECONDS }); } catch { got = 'OK'; }
    if (!got) {
      // Another request is advancing this scan. Give it a moment (so a client
      // that asks again does not spin), then serve what is stored by then.
      await new Promise<void>((r) => setTimeout(r, opts.lockWaitMs ?? LOCK_WAIT_MS));
      try {
        const m = parse<ScanMeta<C>>(await store.get(opts.key));
        if (m && m.v === 1 && Array.isArray(m.chunks)) meta = m;
      } catch { /* keep what was read before */ }
      const status = statusOf(meta, false);
      return result(meta, false, status === 'complete' ? undefined : 'history scan running in another request', []);
    }
  }

  // Last stored chunk, loaded only when there is something to append.
  let tail: Entry<T>[] | null = null;
  let pending: Entry<T>[] = [];
  const unsaved: Entry<T>[] = [];
  let pagesSinceFlush = 0;
  const knownIds = new Set<string>();

  const flush = async (): Promise<void> => {
    if (!store) { unsaved.push(...pending); pending = []; pagesSinceFlush = 0; return; }
    if (pending.length > 0) {
      let index = meta.chunks.length;
      if (tail === null) {
        tail = [];
        const last = meta.chunks.length - 1;
        if (last >= 0 && meta.chunks[last] < CHUNK_TARGET_BYTES) {
          const arr = parse<Entry<T>[]>(await store.get(chunkKey(opts.key, last)));
          if (!Array.isArray(arr)) throw new Error('last history chunk is missing');
          tail = arr; index = last;
        }
      } else if (tail.length > 0) {
        index = meta.chunks.length - 1;
      }
      let entries = [...tail, ...pending];
      const chunks = meta.chunks.slice(0, index);
      // Write as many chunks as the size limit needs; the last one stays open for appends.
      while (entries.length > 0) {
        let take = entries.length;
        let json = JSON.stringify(entries);
        while (json.length > CHUNK_MAX_BYTES && take > 1) { take = Math.ceil(take / 2); json = JSON.stringify(entries.slice(0, take)); }
        await store.set(chunkKey(opts.key, chunks.length), json);
        chunks.push(json.length);
        const rest = entries.slice(take);
        tail = rest.length === 0 && json.length < CHUNK_TARGET_BYTES ? entries.slice(0, take) : [];
        entries = rest;
      }
      meta = { ...meta, chunks };
      pending = [];
    }
    // Meta is written AFTER the chunks it points at: a crash in between leaves
    // an unreferenced chunk, never a reference to a missing one.
    meta = { ...meta, updatedAt: now() };
    await store.set(opts.key, JSON.stringify(meta));
    pagesSinceFlush = 0;
  };

  let failed = false;
  let reason: string | undefined;
  try {
    if (meta.kept > 0 && meta.seg) {
      // Resuming mid-segment: a page may overlap what is stored (a retry after a
      // crash between chunk and meta). Know the stored ids so nothing is kept twice.
      for (const [, it] of await loadEntries(meta)) knownIds.add(opts.idOf(it));
    }
    if (!meta.seg && !(meta.capped === 'store')) {
      meta = { ...meta, segNo: meta.segNo + 1, seg: { until: meta.head, top: null, cursor: null, pages: 0, no: meta.segNo + 1 } };
    }
    while (meta.seg) {
      if (now() - t0 >= budget) break; // out of time: keep the cursor, continue next request
      const seg: Segment<C> = meta.seg;
      const page = await opts.source.page({ until: seg.until, cursor: seg.cursor, deadlineMs: t0 + budget });
      const firstPass = seg.until === null && !meta.backfillDone;
      let kept = meta.kept;
      page.items.forEach((it, idx) => {
        const id = opts.idOf(it);
        if (knownIds.has(id) || kept >= maxKeptTotal) return;
        knownIds.add(id);
        pending.push([orderOf(seg.no, seg.pages, idx), it]);
        kept += 1;
      });
      const top = seg.top ?? page.top ?? null;
      meta = { ...meta, scanned: meta.scanned + page.scanned, kept };
      pagesSinceFlush += 1;

      const ended = page.next === null;
      const cap: ScanCap | null = kept >= maxKeptTotal ? 'store'
        : firstPass && !ended && meta.scanned >= opts.maxScanned ? 'scanned'
        : firstPass && !ended && kept >= opts.maxKept ? 'kept'
        : null;
      if (ended || cap) {
        // The segment is finished: everything from `top` down to `until` (or to
        // the cap) is covered, so `top` becomes the new head.
        meta = { ...meta, seg: null, head: top ?? meta.head, backfillDone: true, capped: cap ?? meta.capped };
        await flush();
        break;
      }
      meta = { ...meta, seg: { ...seg, top, cursor: page.next, pages: seg.pages + 1 } };
      if (pagesSinceFlush >= PERSIST_EVERY_PAGES || pending.length >= PERSIST_EVERY_ITEMS) await flush();
    }
    if (pending.length > 0 || pagesSinceFlush > 0) await flush();
  } catch (err) {
    failed = true;
    reason = String(err instanceof Error ? err.message : err).slice(0, 160);
    log(`scan stopped: ${reason}`);
    // Keep whatever finished before the failure; the failed page is retried next time.
    try { if (pending.length > 0 || pagesSinceFlush > 0) await flush(); } catch { /* progress since the last flush is rescanned */ }
  } finally {
    if (store) { try { await store.del(lockKey); } catch { /* expires on its own */ } }
  }
  return result(meta, failed, reason, unsaved);
}

/**
 * What is stored for `key` right now, oldest first, WITHOUT advancing the scan.
 * For callers that must not wait on a long scan (an open position's own page).
 * Never throws; `complete` is false whenever the stored scan is not finished.
 */
export async function readStoredScan<T>(key: string, base: ScanStore | null, idOf: (item: T) => string): Promise<{ items: T[]; complete: boolean }> {
  const store: ScanStore | null = envReadOnly() ? overlayStore(base) : base;
  if (!store) return { items: [], complete: false };
  try {
    const m = parse<ScanMeta<unknown>>(await store.get(key));
    if (!m || m.v !== 1 || !Array.isArray(m.chunks)) return { items: [], complete: false };
    const raw = m.chunks.length ? await store.mget(m.chunks.map((_, i) => chunkKey(key, i))) : [];
    const entries: Entry<T>[] = [];
    for (const r of raw) { const arr = parse<Entry<T>[]>(r); if (!Array.isArray(arr)) return { items: [], complete: false }; entries.push(...arr); }
    entries.sort((a, b) => a[0] - b[0]);
    const seen = new Set<string>(); const items: T[] = [];
    for (const [, it] of entries) { const id = idOf(it); if (!seen.has(id)) { seen.add(id); items.push(it); } }
    return { items, complete: statusOf(m, false) === 'complete' };
  } catch {
    return { items: [], complete: false };
  }
}

interface Memo<T> { doneAt: number | null; p: Promise<ScanResult<T>> }
const _memo = new Map<string, Memo<unknown>>();

/**
 * Advance the scan stored under `key` by one time budget and return what is
 * known. Never throws. Concurrent callers on one instance share one run, and a
 * COMPLETE result is reused for a short while so several routes loading the
 * same wallet cost one scan.
 */
export function runResumableScan<T, C>(opts: ScanOptions<T, C>): Promise<ScanResult<T>> {
  const hit = _memo.get(opts.key) as Memo<T> | undefined;
  const nowMs = (opts.now ?? Date.now)();
  if (hit && (hit.doneAt === null || nowMs - hit.doneAt < MEMO_MS)) return hit.p;
  const p = runScan(opts).catch((err): ScanResult<T> => ({
    status: 'failed', complete: false, reason: String(err).slice(0, 160), scanned: 0, kept: 0, mark: '0:failed', items: async () => [],
  }));
  const memo: Memo<T> = { doneAt: null, p };
  _memo.set(opts.key, memo as Memo<unknown>);
  p.then((r) => {
    if (_memo.get(opts.key) !== (memo as Memo<unknown>)) return;
    // Only a complete result is held; anything else is advanced by the next caller.
    if (r.complete) memo.doneAt = (opts.now ?? Date.now)(); else _memo.delete(opts.key);
  });
  return p;
}
