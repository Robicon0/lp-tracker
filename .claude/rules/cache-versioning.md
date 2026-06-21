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
| lp-pnl-events        | v23             | Sprint 1.6 — Tier-1 Upstash Redis persistent price cache added above the in-process historical cache; resolution path changed (warm-Redis claims that previously timed out now resolve) |
| analytics-activity   | v15             | Parity with lp-pnl-events v23 — Sprint 1.6 Redis price-cache tier |
| cetus-activity       | v3              | Cetus V2 deposit/withdrawal event structure |
| bluefin-activity     | v3              | (verify in code before bumping) |

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
