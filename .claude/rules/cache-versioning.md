# Cache Versioning

These rules govern how DefiDesh caches data and when to bump cache versions.
Every fix that changes what is cached or how it's structured must follow
these rules.

## Core principle

Caches make DefiDesh fast. But stale caches make DefiDesh wrong. Every fix
that changes cache contents must bump the cache version so users get fresh
data, not stale data from before the fix.

---

## Rule 1: Cache versioning is mandatory after data-shape changes

When a fix changes the **shape**, **contents**, or **calculation** of what
gets cached, the cache version string must be bumped.

### What counts as a "shape change"
- Adding, removing, or renaming a field in the cached object
- Changing how a field is calculated (e.g., fee value formula changes)
- Adding a new fallback path that changes which positions appear in cache
- Changing the set of positions included (e.g., burned-NFT recovery
  changes which closed positions are cached)

### What does not count
- Pure performance optimization that returns identical results
- Logging/instrumentation changes
- Comments, formatting, refactors with no behavior change

### How to bump
Increment the trailing number in the cache key string:
- `lp-pnl-events-v20` → `lp-pnl-events-v21`
- `cetus-activity-v3` → `cetus-activity-v4`

Never decrement. Never reuse an old version number.

---

## Rule 2: Current cache versions (as of latest session)

These are the cache versions currently in production. Keep this list
updated when versions are bumped.

| Cache key            | Current version | Last bump reason |
|----------------------|-----------------|------------------|
| lp-pnl-events        | v27             | Sprint MOMENTUM — Momentum is now an ACTIVITY_PROTOCOL (open positions route to `/api/momentum/activity` instead of being surfaced as unsupported rejections) AND its closed positions fold into Capital G/L; both change cached LP-P&L output. Parity with analytics-activity v19 |
| analytics-activity   | v19             | Sprint MOMENTUM — Momentum fee + historical-only reward claims now enter analytics Fee Income; re-resolve in lockstep with LP-P&L |
| cetus-activity       | v4              | Sprint 2.2c — Cetus fee-claim SUI side historical-only via `getHistoricalOnlySuiPrice` (FIX-C spotFallback no longer reachable for fee claims; Rule 1a) |
| bluefin-activity     | v5              | Sprint 2.2c — Bluefin fee-claim SUI side historical-only via `getHistoricalOnlySuiPrice` (FIX-C spotFallback no longer reachable for fee claims; Rule 1a) |
| momentum-activity    | (in-process)    | Sprint MOMENTUM — NEW `/api/momentum/activity` wrapped in `withActivityRouteCache` (in-process, URL-keyed, NO `-vN` suffix; clears on every deploy by construction — Rule 4). Fee/reward claims historical-only (Rule 1a); reward valued via `reward_coin_type` → resolveToken, never spot |
| closed_pos_sui       | v1              | Sprint 2.2b — Redis cache of reconstructed CLOSED Sui positions' Capital G/L (key `closed_pos_sui_v1:{protocol}:{wallet}`, now `:cetus:`/`:bluefin:`/`:momentum:` namespaces, 30d TTL). NOT bumped for Sprint MOMENTUM — Momentum is a NEW protocol key, so cetus/bluefin entries are byte-identical. Bump on a closed-position valuation-logic change |
| closed_pos_solana    | v1              | Sprint 3-FREE — Redis cache of reconstructed CLOSED Solana (Orca) positions' Capital G/L + fees (key `closed_pos_solana_v1:orca:{wallet}`, 30d TTL, same immutable contract as closed_pos_sui: empty-never-cached, fire-and-forget, no-op stub). Caches a COMPUTED valued result → versioned; bump on a closed-position valuation-logic change. `lp-pnl-events`/`analytics-activity` NOT bumped for Sprint 3-FREE (closed Solana positions were never in the dashboard positions array — Sprint 2.2b reasoning) |

If a version listed here doesn't match what's in code, code is the source
of truth. Update this table to match code, not the other way around.

---

## Rule 3: Cache TTL by result type

Different result types deserve different cache durations.

### Success results: 5 minutes
A successfully resolved set of positions/fees/prices is cached for 5 minutes.
Long enough to absorb repeat requests, short enough to reflect on-chain
changes quickly.

### Empty results: 60 seconds
An empty result (wallet has no positions, protocol has no activity) is
cached for 60 seconds. This prevents stampedes against slow chains when a
wallet legitimately has nothing — but doesn't lock in "empty" for long
enough that a newly-opened position is invisible.

### Error results: not cached
Errors are never cached. A transient RPC failure or CoinGecko rate-limit
should not poison the cache for the next user. Re-attempt on the next
request.

### Reference
Differentiated TTLs introduced in commit 751743b.

---

## Rule 4: Server-side vs. client-side cache

DefiDesh uses both server-side route caches (Next.js API route caches) and
client-side React caches (useState, useEffect, localStorage).

### Server-side (preferred for cross-user data)
Use server-side caching for anything that's the same across users:
- CoinGecko price data
- Pool metadata from DefiLlama
- Token symbol/ID mappings

Server-side cache warms once, serves many users. Cold start cost is paid
once per cache miss across the entire user base.

### Activity-route cache + in-flight dedup (Sprint 1.13)
`app/lib/activityRouteCache.ts` (`withActivityRouteCache`) wraps every
`/api/{protocol}/activity` route with an in-process (per-instance) result cache
**plus in-flight dedup**. It exists because the analytics page fetches each
position's activity route 2-3× (useAllPositionsActivity + useLpPnl +
useWalletLevelFees), and the routes had no server-side cache — so on a cold
instance the expensive Etherscan/archive deposit scan and CoinGecko-historical
claim lookups ran 2-3× per position (the dominant cause of the 3-5 min cold first
load). The in-flight dedup is the key win: simultaneous identical requests share
ONE computation instead of each re-running the scan + pricing. TTLs follow Rule 3
(5 min success / 60 s empty / errors never cached). This is an **in-process module
cache, NOT a versioned key** — it carries no `-vN` string and needs no version
bump; it clears on every deploy/cold start by construction. A cache hit/dedup
returns the EXACT JSON the route produced, so no pricing/instrumentation invariant
changes (claims still claim-date-only, Rule 1a). Keyed by route pathname + sorted
search params, so any change to a route's params (incl. current spot p0/p1)
naturally yields a fresh entry.

### Closed-position deposit-history cache (Sprint 1.14)
`app/lib/depositHistoryCache.ts` persists a CLOSED HyperEVM position's raw
deposit/withdrawal/fee logs in Upstash Redis, keyed by `(nftManager, tokenId)`,
30-day TTL. It exists because those positions are retrievable ONLY via Tier 1
(Etherscan V2, `fromBlock=0`) — Tier 2 (Chainstack archive) only covers the last
~57 days and is plan-blocked for true archive — so when Etherscan's free-tier
rate limit throttles Tier 1 under load, the position's deposits are dropped and
analytics excludes it ("Deposit history could not be retrieved"). A closed
position's on-chain history is IMMUTABLE, so the first successful live retrieval
is persisted and every later load (any instance, any user) serves from Redis,
never re-hitting Etherscan. Scope/safety: CLOSED positions only (the activity URL
carries `closed=1`; open positions can gain deposits and are never cached); a
deposit-less / empty result is NEVER written (Tier 1 now fails on 0 deposit logs
rather than returning a deposit-less success — see instrumentation.md). Persistent
Redis (Sprint 1.6 contract: own client, `PRICE_CACHE_KV_*`, no-op stub, never
throws, fire-and-forget writes), NOT a versioned key — no version bump; serving
cached logs is byte-identical to a fresh retrieval (the downstream parser runs
unchanged).

### Closed-Sui-position Capital G/L cache (Sprint 2.2b)
`app/lib/suiClosedPositions.ts` persists each wallet's reconstructed CLOSED
Cetus/Bluefin positions (Capital G/L + valued events) in Upstash Redis, keyed
`closed_pos_sui_v1:{protocol}:{wallet}`, 30-day TTL. A closed Sui position's object
is destroyed on close, so its lifecycle is immutable (events on a finalized
ledger) — the first successful reconstruction is served thereafter (any instance,
any user) without re-scanning tx history (cold ~49s → warm ~1s). UNLIKE the Sprint
1.14 deposit cache this one IS a versioned key (`closed_pos_sui_v1`) because it
caches a COMPUTED result (valued Capital G/L), not raw logs — bump the version
suffix to invalidate on a valuation-logic change. Same Sprint 1.14 contract
otherwise: own client, `PRICE_CACHE_KV_*`, no-op stub if unset, never throws,
fire-and-forget writes, EMPTY results never cached (a transient empty scan must
not freeze in as "no closed positions"). The existing `lp-pnl-events` /
`analytics-activity` localStorage caches were NOT bumped for Sprint 2.2b — they
cache per-position activity events for positions in the dashboard array, and
closed (destroyed-object) Sui positions were never in that array, so their cached
contents are byte-identical (Rule 1: bump only when cached contents change).

### Closed-Solana-position Capital G/L cache (Sprint 3-FREE)
`app/lib/solanaClosedPositions.ts` persists each wallet's reconstructed CLOSED
Orca positions (Capital G/L + fees + valued events) in Upstash Redis, keyed
`closed_pos_solana_v1:orca:{wallet}`, 30-day TTL — the direct Solana analogue of
the Sprint 2.2b cache above, under the identical contract (versioned COMPUTED
result; own client, `PRICE_CACHE_KV_*`, no-op stub, never throws, fire-and-forget,
EMPTY never cached). It matters more here than on Sui: the underlying scan is a
paced free-tier Alchemy wallet-history backfill (~25–40k CU, ~40–120 s once per
wallet), so the cache is what makes the feature free at scale — every repeat load
(any instance, any user) is ~0 CU / ~0.2–0.8 s. One nuance observed in B7: an
immediate same-process re-read can race the fire-and-forget write (harmless — the
re-read just rescans); production requests seconds apart always serve warm.

### Client-side (for per-user data only)
Use client-side caching only for data that's specific to one wallet:
- Resolved LP P&L for a connected wallet
- Per-wallet activity history
- Wallet-specific settings (e.g., disconnected flags)

Client-side cache is per-browser. It does not benefit other users. Do not
use client-side caching for data that would benefit from server-side
warming.

---

## Rule 5: Cold-start cache warming

DefiDesh currently has a cold-start cost problem on HyperEVM: the first
user of the day pays the full CoinGecko historical fetch cost for HYPE,
SUI, and other non-stablecoin tokens. Subsequent users in the same session
benefit from the warm cache.

### Current state
No server-side warming. Each Vercel cold start re-fetches CoinGecko
historical data.

### Planned (Sprint 1)
Server-side price cache via Vercel KV (free tier) or in-memory module
cache so the second user inherits the first user's warm CoinGecko data.
This will resolve the Account 2 ProjectX cold-start regression.

---

## Rule 6: Cache invalidation triggers

When a cache version is bumped, also document the trigger in CLAUDE.md
under the active sprint or in commit message.

### Triggers that require a version bump
- Pricing rule change (e.g., switching CETUS from historical to spot)
- Position discovery mechanism change (e.g., burned-NFT recovery added)
- Calculation formula change (e.g., Capital G/L formula refined)
- New protocol added (forces re-fetch for that protocol)
- New chain added (forces re-fetch for that chain)

### Triggers that do not require a version bump
- New instrumentation/logging
- New error message text
- UI-only changes (display formatting, colors, layout)
- Documentation updates

---

## Decision tree: "Do I need to bump the cache version?"

1. **Did my fix change what gets stored in the cache?**
   - No → no bump needed
   - Yes → continue

2. **Could a user with a cached result see wrong data after my fix
   compared to a user with a fresh fetch?**
   - No → no bump needed
   - Yes → continue

3. **Bump the cache version. Update the table in Rule 2. Note the bump
   reason in the commit message.**

---

## When to amend this file

Amend cache-versioning.md when:
- A new cache layer is added (e.g., Redis introduced for server-side warming)
- A cache TTL is changed based on evidence (e.g., 60s empty cache proves
  too aggressive or not aggressive enough)
- A new category of cache trigger emerges (e.g., a new pricing source
  added that requires its own version sequence)

Always update the version table in Rule 2 when a version is bumped in code.
