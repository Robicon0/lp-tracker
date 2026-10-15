// The ONE way to open the shared Upstash store, and the guard that keeps a local
// dev server, a test script or a Preview deployment from writing to it.
//
// WHY THIS EXISTS
// There is one Upstash database for production, preview and local. Methodology
// rule (f) records what that has cost: a Preview deployment, missing an archive
// RPC variable, stored today's HyperEVM pool price as the price at four May
// blocks for 90 days, and production read it (ProjectX Capital G/L −2,206.73
// instead of +111.08 for about a day). `CLOSED_POS_CACHE_READONLY=1` protects the
// closed-position lists and history scans only, and only when someone remembers
// to set it.
//
// THE RULE (fails closed)
// Writes reach the shared store only when `VERCEL_ENV === 'production'`. Anywhere
// else, INCLUDING an unset or unknown VERCEL_ENV, writes are kept in this
// process's memory instead (an overlay): the process reads back what it wrote,
// so locks, resumable scans and caches behave the same within the run, while
// reads that miss the overlay still come from the shared store (a local run
// sees production's warm caches). Nothing a non-production process does can
// change what production reads.
//
// A deliberate maintenance run that must write from a laptop sets
// `SHARED_STORE_WRITES=allow-nonproduction` for that one command.
//
// Only `get` / `mget` (and other read-only commands) reach the store unchanged in
// overlay mode; `set` / `del` / `mset` go to the overlay; any other command is
// refused (logged once, answers null) — an unknown command is treated as a write.

import { Redis } from '@upstash/redis';

export type SharedStoreMode = 'write' | 'overlay';

export function sharedStoreMode(env: Record<string, string | undefined> = process.env): SharedStoreMode {
  if (env.VERCEL_ENV === 'production') return 'write';
  if (env.SHARED_STORE_WRITES === 'allow-nonproduction') return 'write';
  return 'overlay';
}

// Read-only commands that may go to the shared store as they are.
const READ_COMMANDS = new Set(['get', 'mget', 'exists', 'ttl', 'pttl', 'type', 'strlen', 'scan', 'keys', 'hget', 'hgetall', 'smembers', 'dbsize']);

interface Entry { raw: string | null; expiresAt: number | null } // raw null = deleted here

// Upstash serialises a non-string value with JSON.stringify and parses a stored
// string back when it is JSON; the overlay does the same so a value read back
// from it has the shape the store would have returned.
const encode = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));
const decode = (raw: string): unknown => { try { return JSON.parse(raw); } catch { return raw; } };

type SetOpts = { ex?: number; px?: number; nx?: boolean; xx?: boolean } | undefined;

/** Wraps a store client so writes stay in this process. Exported for the tests. */
export function overlayStore<T extends object>(real: T, label = 'store'): T {
  const mem = new Map<string, Entry>();
  const warned = new Set<string>();
  const live = (k: string): Entry | undefined => {
    const e = mem.get(k);
    if (e && e.expiresAt != null && Date.now() >= e.expiresAt) { mem.delete(k); return undefined; }
    return e;
  };
  const r = real as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;

  const handlers: Record<string, (...a: unknown[]) => Promise<unknown>> = {
    async get(key) {
      const e = live(String(key));
      if (e) return e.raw == null ? null : decode(e.raw);
      return r.get.call(real, key);
    },
    async mget(...args) {
      const keys = (Array.isArray(args[0]) ? args[0] : args).map(String);
      const missing = keys.filter((k) => !live(k));
      const fetched = missing.length ? ((await r.mget.call(real, ...missing)) as unknown[]) : [];
      const fromStore = new Map(missing.map((k, i) => [k, fetched[i] ?? null]));
      return keys.map((k) => { const e = live(k); return e ? (e.raw == null ? null : decode(e.raw)) : fromStore.get(k) ?? null; });
    },
    async set(key, value, opts) {
      const k = String(key);
      const o = opts as SetOpts;
      if (o?.nx && live(k)?.raw != null) return null;
      if (o?.xx && live(k)?.raw == null) return null;
      const ttlMs = o?.px ?? (o?.ex != null ? o.ex * 1000 : null);
      mem.set(k, { raw: encode(value), expiresAt: ttlMs != null ? Date.now() + ttlMs : null });
      return 'OK';
    },
    async mset(obj) {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) mem.set(k, { raw: encode(v), expiresAt: null });
      return 'OK';
    },
    async del(...args) {
      const keys = (Array.isArray(args[0]) ? args[0] : args).map(String);
      for (const k of keys) mem.set(k, { raw: null, expiresAt: null });
      return keys.length;
    },
  };

  return new Proxy(real, {
    get(target, prop, receiver) {
      if (typeof prop !== 'string') return Reflect.get(target, prop, receiver);
      if (handlers[prop]) return handlers[prop];
      const orig = Reflect.get(target, prop, receiver);
      if (typeof orig !== 'function') return orig;
      if (READ_COMMANDS.has(prop)) return orig.bind(target);
      return async () => {
        if (!warned.has(prop)) {
          warned.add(prop);
          console.warn(`[sharedStore] ${label}: "${prop}" refused outside production (VERCEL_ENV=${process.env.VERCEL_ENV ?? 'unset'})`);
        }
        return null;
      };
    },
  }) as T;
}

let announced = false;

/**
 * The shared store client for `label`, or null when the store is not
 * configured. In production it is the plain client; anywhere else writes stay
 * in this process (see the header).
 */
export function createSharedRedis(label: string): Redis | null {
  const url = process.env.PRICE_CACHE_KV_REST_API_URL;
  const token = process.env.PRICE_CACHE_KV_REST_API_TOKEN;
  if (!url || !token) return null;
  let client: Redis;
  try {
    client = new Redis({ url, token });
  } catch (err) {
    console.warn(`[${label}] Redis client construction failed; no-op stub:`, err);
    return null;
  }
  if (sharedStoreMode() === 'write') return client;
  if (!announced) {
    announced = true;
    console.warn(`[sharedStore] VERCEL_ENV=${process.env.VERCEL_ENV ?? 'unset'}: writes to the shared store stay in this process`);
  }
  return overlayStore(client, label);
}
