// app/lib/tokenResolver.ts
//
// Shared, platform-wide token IDENTITY resolver (Sprint 1.10).
//
// Problem it solves: before this module, every position route carried its own
// hardcoded `KNOWN_COINS` / `KNOWN_TOKENS` / `TOKENS` map of token -> CoinGecko
// id. A user holding a token NOT in that route's map got, at best, an unpriced
// position ("Current price data unavailable") and, on Aerodrome/Velodrome, a
// SILENTLY CORRUPTED amount (decimals defaulted to 18). This does not scale to
// worldwide adoption — new tokens launch daily and nobody can hand-maintain
// per-route lists.
//
// This module turns "is the token in a hardcoded list?" into "resolve it
// automatically": given an on-chain identifier (EVM/HyperEVM contract, Solana
// mint, or Sui coin type), it returns the token's symbol, decimals, and (where
// discoverable) its CoinGecko id, with a `priceable` flag and the `source` that
// answered. It NEVER throws and NEVER returns wrong decimals — when nothing
// resolves it returns correct on-chain symbol/decimals with `priceable:false`
// so the UI can show the amount with "price unavailable" (Option A).
//
// Resolution cascade (first hit wins):
//   1. In-process + Upstash Redis cache (cross-instance, cross-user)
//   2. Hardcoded high-stakes constants (native tokens + canonical stables)
//   3. CoinGecko contract lookup  /coins/{platform}/contract/{address}
//   4. On-chain metadata (Sui getCoinMetadata / Helius DAS / EVM eth_call) —
//      AUTHORITATIVE for symbol + decimals. THIS is the Tier-3 decimals fix.
//   5. CoinGecko symbol search (existing cgSymbolSearch)
//   6. DeFiLlama coverage check (informational this sprint — records that the
//      token exists there for a future pricing-integration sprint; does NOT
//      make the token priceable yet)
//   7. Graceful unresolvable (correct symbol/decimals, priceable:false)
//
// All CoinGecko HTTP flows through the process-wide `withCgPacing` queue
// (concurrency 1, ~1100ms gap) so cold-cache long-tail discovery can never
// burst CoinGecko's free-tier per-IP budget. Redis warming makes the cost
// one-time, platform-wide.
//
// Pricing stays where it already lives: this module returns a `cgId`; routes
// feed that into their existing CoinGecko pricing pipeline
// (fetchCachedCoinGeckoPrices). The resolver is identity, not price.
//
// Stablecoins / CETUS reward token: NOT touched. Stablecoins resolve via the
// hardcoded constants to their CoinGecko id (usd-coin/tether/dai), exactly as
// the dashboard routes price them today. The CETUS reward spot+LKG path
// (pricing-invariants Rule 1 exception) is USD valuation, a separate concern,
// and never calls this module.

import { Redis } from '@upstash/redis';
import { withCgPacing } from './cgPriceHistory';
import { resolveCgId } from './cgSymbolSearch';
import { logPrice } from './priceLogger';
import { suiRpc } from './suiRpc';
import {
  type Chain,
  CG_PLATFORM,
  DEFILLAMA_CHAIN,
  normalizeIdentifier,
  lookupHardcodedToken,
} from './tokenConstants';

export type { Chain } from './tokenConstants';

export type ResolveSource =
  | 'redis-cache'
  | 'hardcoded-constant'
  | 'cg-contract'
  | 'onchain-symbol-search'
  | 'defillama'
  | 'unresolvable';

export interface ResolvedToken {
  symbol: string; // always present (on-chain / fallback if needed)
  decimals: number; // always present (NEVER a blind 18 default)
  cgId: string | null; // null if no CoinGecko id could be discovered
  priceable: boolean; // cgId !== null (stables carry a cgId, so they are priceable)
  source: ResolveSource;
}

export interface TokenIdentifier {
  chain: Chain;
  contractAddress?: string; // EVM / HyperEVM
  mint?: string; // Solana
  suiType?: string; // Sui
  // Optional caller-supplied symbol (e.g. a route that already fetched on-chain
  // metadata). Lets the resolver skip its own metadata round-trip and use this
  // for symbol search. On-chain truth always wins over this if the resolver
  // fetches metadata itself.
  symbolHint?: string;
  // Optional caller-supplied decimals (same rationale).
  decimalsHint?: number;
}

// ── Generic Redis layer ──────────────────────────────────────────────────────
// Mirrors the Sprint 1.6 redisPriceCache construction (same PRICE_CACHE_KV_*
// env, same defensive no-op stub) but keeps its OWN client + key namespace so
// the historical-price module stays untouched. NEVER throws, NEVER blocks.
const REST_URL = process.env.PRICE_CACHE_KV_REST_API_URL;
const REST_TOKEN = process.env.PRICE_CACHE_KV_REST_API_TOKEN;
let redis: Redis | null = null;
if (REST_URL && REST_TOKEN) {
  try {
    redis = new Redis({ url: REST_URL, token: REST_TOKEN });
  } catch (err) {
    console.warn('[tokenResolver] Redis client construction failed; no-op stub:', err);
    redis = null;
  }
}

// TTLs (seconds). Identity is immutable; only price discovery might improve.
const TTL_PRICEABLE = 30 * 24 * 60 * 60; // 30d — resolved cgId
const TTL_METADATA_ONLY = 90 * 24 * 60 * 60; // 90d — real symbol/decimals, no cgId
const TTL_NEGATIVE = 24 * 60 * 60; // 24h — nothing known (retry sooner)

function redisKey(chain: Chain, normId: string): string {
  return `token:resolve:${chain}:${normId}`;
}

async function redisGet(chain: Chain, normId: string): Promise<ResolvedToken | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get<ResolvedToken | string | null>(redisKey(chain, normId));
    if (raw == null) return null;
    const obj = typeof raw === 'string' ? (JSON.parse(raw) as ResolvedToken) : raw;
    if (obj && typeof obj.symbol === 'string' && typeof obj.decimals === 'number') {
      return obj;
    }
    return null;
  } catch {
    return null; // miss on error
  }
}

function redisSet(chain: Chain, normId: string, value: ResolvedToken, ttl: number): void {
  if (!redis) return;
  // Fire-and-forget — never await, never block the resolution return.
  void redis
    .set(redisKey(chain, normId), JSON.stringify(value), { ex: ttl })
    .catch((err) => console.warn('[tokenResolver] Redis write failed (ignored):', err));
}

// ── In-process cache + in-flight dedup ───────────────────────────────────────
// Multiple positions in one render holding the same unmapped token resolve once.
const memCache = new Map<string, ResolvedToken>();
const inFlight = new Map<string, Promise<ResolvedToken>>();

// ── Per-chain RPC endpoints (per-chain PARAMETERS, allowed by
// architecture-principles Rule 2 — no per-chain LOGIC branches). ──────────────
const ALCHEMY = process.env.NEXT_PUBLIC_ALCHEMY_KEY ?? '';
const EVM_RPC: Partial<Record<Chain, string>> = {
  ethereum: `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY}`,
  arbitrum: `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY}`,
  optimism: `https://opt-mainnet.g.alchemy.com/v2/${ALCHEMY}`,
  base: `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY}`,
  polygon: `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY}`,
  hyperevm: 'https://rpc.hyperliquid.xyz/evm',
};
const SOLANA_RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY ?? ''}`;

const EVM_CHAINS: ReadonlySet<Chain> = new Set<Chain>([
  'ethereum', 'arbitrum', 'optimism', 'base', 'polygon', 'hyperevm',
]);

// ── Identifier helpers ───────────────────────────────────────────────────────
// Returns the raw on-chain identifier for a TokenIdentifier (by chain).
function rawIdentifier(id: TokenIdentifier): string | null {
  if (id.chain === 'sui') return id.suiType ?? null;
  if (id.chain === 'solana') return id.mint ?? null;
  return id.contractAddress ?? null; // EVM family
}

function addrFallbackSymbol(chain: Chain, raw: string): string {
  // EVM: first 6 hex of the address (matches existing route fallbacks).
  if (EVM_CHAINS.has(chain)) return raw.replace(/^0x/, '').slice(0, 6).toUpperCase();
  // Sui: the TYPE tail (e.g. ...::foo::BAR -> BAR).
  if (chain === 'sui') return raw.split('::').pop() || raw.slice(0, 6);
  // Solana: first 6 of the mint.
  return raw.slice(0, 6);
}

// ── CoinGecko contract lookup ────────────────────────────────────────────────
// GET /coins/{platform}/contract/{address}. Through withCgPacing. Returns the
// CoinGecko id + symbol + decimals (decimals may be null if CG omits it).
interface CgContractResult {
  cgId: string;
  symbol: string;
  decimals: number | null;
}
async function cgContractLookup(
  chain: Chain,
  rawAddr: string,
): Promise<CgContractResult | null> {
  const platform = CG_PLATFORM[chain];
  if (!platform) return null;
  return withCgPacing(async () => {
    try {
      const url = `https://api.coingecko.com/api/v3/coins/${platform}/contract/${rawAddr}`;
      const res = await fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!res.ok) return null; // 404 (not listed) / 429 / etc. -> fall through
      const json = (await res.json()) as {
        id?: string;
        symbol?: string;
        detail_platforms?: Record<string, { decimal_place?: number | null }>;
      };
      if (!json?.id) return null;
      const dp = json.detail_platforms?.[platform]?.decimal_place;
      return {
        cgId: json.id,
        symbol: (json.symbol || '').toUpperCase(),
        decimals: typeof dp === 'number' ? dp : null,
      };
    } catch {
      return null;
    }
  });
}

// ── On-chain metadata (chain-dispatched) ─────────────────────────────────────
interface OnchainMeta {
  symbol: string | null;
  decimals: number | null;
}

async function suiMetadata(coinType: string): Promise<OnchainMeta | null> {
  try {
    // Sprint SUI-RPC-RELIABILITY: shared paced+failover Sui client (was a bare fetch).
    const r = (await suiRpc('suix_getCoinMetadata', [coinType])) as { decimals?: number; symbol?: string } | null;
    if (r && (typeof r.symbol === 'string' || typeof r.decimals === 'number')) {
      return { symbol: r.symbol ?? null, decimals: typeof r.decimals === 'number' ? r.decimals : null };
    }
    return null;
  } catch {
    return null;
  }
}

async function solanaMetadata(mint: string): Promise<OnchainMeta | null> {
  try {
    const res = await fetch(SOLANA_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAssetBatch', params: { ids: [mint] } }),
    });
    const json = await res.json();
    const asset = (json?.result || [])[0];
    if (!asset?.id) return null;
    const symbol: string | null = asset.content?.metadata?.symbol || null;
    const decimals: number | null =
      typeof asset.token_info?.decimals === 'number' ? asset.token_info.decimals : null;
    return { symbol, decimals };
  } catch {
    return null;
  }
}

// EVM symbol/decimals via raw eth_call, replicating the proven decode in
// app/api/hyperswap/route.ts (UTF-8 ABI string OR bytes32 short string).
const SEL_SYMBOL = '0x95d89b41';
const SEL_DECIMALS = '0x313ce567';

function decodeHexStringUtf8(hex: string, strLen: number): string {
  const strHex = hex.slice(0, strLen * 2);
  const bytes = new Uint8Array(strLen);
  for (let i = 0; i < strLen; i++) bytes[i] = parseInt(strHex.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder('utf-8').decode(bytes).replace(/\0/g, '');
}
function cleanSymbol(s: string): string {
  return s
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '')
    .trim();
}
async function evmCall(rpc: string, to: string, data: string): Promise<string> {
  try {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to, data }, 'latest'], id: 1 }),
    });
    const json = await res.json();
    return json.result || '0x';
  } catch {
    return '0x';
  }
}
async function evmMetadata(chain: Chain, addr: string): Promise<OnchainMeta | null> {
  const rpc = EVM_RPC[chain];
  if (!rpc) return null;
  const [symResult, decResult] = await Promise.all([
    evmCall(rpc, addr, SEL_SYMBOL),
    evmCall(rpc, addr, SEL_DECIMALS),
  ]);
  let symbol: string | null = null;
  if (symResult && symResult.length > 130) {
    const hex = symResult.startsWith('0x') ? symResult.slice(2) : symResult;
    const strLen = parseInt(hex.slice(64, 128), 16);
    symbol = cleanSymbol(decodeHexStringUtf8(hex.slice(128), strLen)) || null;
  } else if (symResult && symResult !== '0x' && symResult.length === 66) {
    const hex = symResult.startsWith('0x') ? symResult.slice(2) : symResult;
    symbol = cleanSymbol(decodeHexStringUtf8(hex, 32)) || null;
  }
  let decimals: number | null = null;
  if (decResult && decResult !== '0x') {
    const d = parseInt(decResult, 16);
    if (Number.isFinite(d) && d >= 0 && d <= 36) decimals = d;
  }
  if (symbol == null && decimals == null) return null;
  return { symbol, decimals };
}

async function onchainMetadata(chain: Chain, raw: string): Promise<OnchainMeta | null> {
  if (chain === 'sui') return suiMetadata(raw);
  if (chain === 'solana') return solanaMetadata(raw);
  if (EVM_CHAINS.has(chain)) return evmMetadata(chain, raw);
  return null;
}

// ── DeFiLlama coverage check (informational only this sprint) ─────────────────
// Returns true if DeFiLlama has a current price for the contract. We do NOT use
// the price in the live path yet (locked scope decision) — this records the
// token as future-priceable.
async function defiLlamaHasCoverage(chain: Chain, raw: string): Promise<boolean> {
  const dlChain = DEFILLAMA_CHAIN[chain];
  if (!dlChain) return false;
  try {
    const res = await fetch(`https://coins.llama.fi/prices/current/${dlChain}:${raw}`, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { coins?: Record<string, { price?: number }> };
    const entry = json?.coins?.[`${dlChain}:${raw}`];
    return !!entry && typeof entry.price === 'number' && entry.price > 0;
  } catch {
    return false;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────
export async function resolveToken(id: TokenIdentifier): Promise<ResolvedToken> {
  const { chain } = id;
  const raw = rawIdentifier(id);
  if (!raw) {
    // No identifier at all — cannot resolve. Return a minimal, honest record.
    return { symbol: id.symbolHint || 'UNKNOWN', decimals: id.decimalsHint ?? 0, cgId: null, priceable: false, source: 'unresolvable' };
  }
  const normId = normalizeIdentifier(chain, raw);
  const cacheKey = `${chain}:${normId}`;

  const mem = memCache.get(cacheKey);
  if (mem) return mem;

  const pending = inFlight.get(cacheKey);
  if (pending) return pending;

  const promise = (async (): Promise<ResolvedToken> => {
    const t0 = Date.now();
    try {
      // Step 1 — Redis cache.
      const cached = await redisGet(chain, normId);
      if (cached) {
        const out: ResolvedToken = { ...cached, source: 'redis-cache' };
        memCache.set(cacheKey, out);
        emitUsed(chain, normId, out, Date.now() - t0);
        return out;
      }

      // Step 2 — Hardcoded high-stakes constants (native + canonical stables).
      const hc = lookupHardcodedToken(chain, normId);
      if (hc) {
        const out: ResolvedToken = {
          symbol: hc.symbol, decimals: hc.decimals, cgId: hc.cgId, priceable: true, source: 'hardcoded-constant',
        };
        memCache.set(cacheKey, out);
        redisSet(chain, normId, out, TTL_PRICEABLE);
        emitUsed(chain, normId, out, Date.now() - t0);
        return out;
      }

      let cgId: string | null = null;
      let symbol: string | null = id.symbolHint ?? null;
      let decimals: number | null = id.decimalsHint ?? null;
      let source: ResolveSource = 'unresolvable';
      let metadataKnown = false; // did we obtain a REAL on-chain/CG symbol+decimals?

      // Step 3 — CoinGecko contract lookup.
      const cg = await cgContractLookup(chain, raw);
      if (cg) {
        cgId = cg.cgId;
        source = 'cg-contract';
        if (cg.symbol) symbol = cg.symbol;
        if (cg.decimals != null) {
          decimals = cg.decimals;
          metadataKnown = true;
        }
      }

      // Step 4 — On-chain metadata (authoritative symbol+decimals). Run when we
      // still lack a cgId OR still lack decimals (the Tier-3 decimals fix:
      // decimals must be on-chain truth, never a blind 18). On-chain wins over
      // any hint / CG symbol for display fidelity.
      if (cgId === null || decimals == null) {
        const meta = await onchainMetadata(chain, raw);
        if (meta) {
          if (meta.symbol) symbol = meta.symbol;
          if (meta.decimals != null) {
            decimals = meta.decimals;
            metadataKnown = true;
          }
          if (meta.symbol || meta.decimals != null) metadataKnown = metadataKnown || meta.decimals != null;
        }
      }

      // Step 5 — CoinGecko symbol search (only if still no cgId).
      if (cgId === null && symbol) {
        const bySymbol = await resolveCgId(symbol);
        if (bySymbol) {
          cgId = bySymbol;
          source = 'onchain-symbol-search';
        }
      }

      // Step 6 — DeFiLlama coverage check (informational; does NOT price).
      if (cgId === null) {
        const onLlama = await defiLlamaHasCoverage(chain, raw);
        if (onLlama) source = 'defillama';
      }

      // Step 7 — Finalize with graceful fallbacks. Symbol always present;
      // decimals NEVER a blind 18 (0 when truly unknown, per spec edge case).
      if (!symbol) symbol = addrFallbackSymbol(chain, raw);
      if (decimals == null) {
        decimals = 0;
        console.warn(`[tokenResolver] no decimals for ${chain}:${normId} — defaulting to 0 (not 18)`);
      }
      const priceable = cgId !== null;
      if (cgId === null && source !== 'defillama') source = 'unresolvable';

      const out: ResolvedToken = { symbol, decimals, cgId, priceable, source };
      memCache.set(cacheKey, out);

      // Cache write with outcome-appropriate TTL.
      const ttl = priceable ? TTL_PRICEABLE : metadataKnown ? TTL_METADATA_ONLY : TTL_NEGATIVE;
      redisSet(chain, normId, out, ttl);

      emitUsed(chain, normId, out, Date.now() - t0);
      if (!priceable) {
        // Distinct, grep-able failure event for production monitoring. The
        // token still renders (correct symbol/decimals) — this is a price
        // DISCOVERABILITY gap, not a crash.
        logPrice({
          event: 'token_resolution_failed',
          chain,
          identifier: normId,
          lastSourceTried: source,
          symbol,
          decimals,
        });
      }
      return out;
    } finally {
      inFlight.delete(cacheKey);
    }
  })();

  inFlight.set(cacheKey, promise);
  return promise;
}

// Batch helper — resolve many identifiers in parallel (the in-flight dedup +
// withCgPacing queue keep CoinGecko bursts serialized regardless).
export async function resolveTokens(ids: TokenIdentifier[]): Promise<ResolvedToken[]> {
  return Promise.all(ids.map((id) => resolveToken(id)));
}

// ── Instrumentation ──────────────────────────────────────────────────────────
// One token_resolver_used per resolution (Sprint 1.10). Grep target:
// '"event":"token_resolver_used"'. The `source` field is the resolver cascade
// tier that answered — distinct from the price-resolution Source enum.
function emitUsed(chain: Chain, normId: string, t: ResolvedToken, ms: number): void {
  logPrice({
    event: 'token_resolver_used',
    chain,
    identifier: normId,
    source: t.source,
    priceable: t.priceable,
    cgId: t.cgId,
    symbol: t.symbol,
    decimals: t.decimals,
    latencyMs: ms,
  });
}
