# Sprint ORCA-FREE-FIX — Phase A (read-only investigation)

**Date:** 2026-07-04 · **Account:** Account 1 Solana `GndRty…pogC` · **Mode:** READ ONLY
(no file edits, no commits, no build). All numbers below are from live free-tier RPC
account reads + bounded position-PDA signature scans + DeFiLlama/CoinGecko read-only
lookups. **No paid-Helius tx-history scan was run.**

---

## TL;DR — the honest split

The Orca gap is **almost entirely closed positions**, which are genuinely Helius-gated.
The free-tier-recoverable dollars are **tiny** and, for the most part, **already showing**.

| Bucket | Amount | Free-tier fixable? |
|---|---|---|
| Open-position **lifetime claimed** fees (2 positions, already reconstructable free-tier) | **≈ $174.35** | ✅ already shows; can be made *reliable/correct-by-construction* |
| Open-position **uncollected** (settled + pending, shown separately as "Uncollected") | **≈ $70.88** | ✅ already shows |
| **Closed** positions (18, NFT burned → invisible to `getNftMints`) | **≈ $2,196** (= ~$2,370 record − ~$174 open) | ❌ **Helius-gated** (needs paid wallet tx-scan) |

**Conclusion (stated plainly, per the brief):** there is **no large hidden pot of free-tier
Orca fees**. The ~$2,370-vs-~$174 gap is not open-position mispricing — it is the 18 closed
positions being invisible, exactly as Sprint 3 Phase A predicted. The free-tier work in this
sprint is **correctness/robustness + latent-bug cleanup**, not a big dollar recovery for Osho.
The real money (~$2,196) stays locked behind the $49/mo Helius Developer decision.

---

## 1. Decomposition of the Orca gap

### 1a. Open positions (free-tier visible) — enumerated live

`getNftMints` (both Token + Token-2022 programs, `amount===1 && decimals===0`) → derive
position PDA → `getMultipleAccounts` → decode. **Account 1 owns exactly 2 NFT-like tokens,
both decode to OPEN Orca positions** (liquidity > 0):

| Pair | Position PDA | Pool | Status | On-chain mintA | Uncollected (settled+pending) |
|---|---|---|---|---|---|
| ZEC/USDC | `CQRttAmw…` | `GTHKH8s8…` | Out of Range (cur 15249 > upper 15040) | **`A7bdiYdS…`** | **≈ $51.42** (0.0514 ZEC + 27.81 USDC) |
| SOL/USDC | `3qsDxnB7…` | `Czfq3xZZ…` | Out of Range (cur −24891 < lower −26888) | `So1111…112` (SOL) | **≈ $19.46** (0.0839 SOL + 6.87 USDC) |

Settled `feeOwedA/B` = 0 on both; the uncollected above is the **pending** fee-growth delta
(computed with the shared underflow guard). Combined uncollected ≈ **$70.88**.

**Lifetime CLAIMED fees** — reconstructed free-tier by scanning each **position PDA's** own
signatures (not the wallet's full history) and valuing each `collect_fees` via DeFiLlama
historical-by-mint (the exact source `app/api/orca/activity/route.ts` uses):

| Pair | Fee-claim txns | Claims | Lifetime claimed USD |
|---|---|---|---|
| ZEC/USDC | 1 | 2026-07-01: 0.0742 ZEC @ $400.73 + 33.18 USDC | **$62.89** |
| SOL/USDC | 2 | 2026-07-01: 0.4974 SOL @ $74.58 + 36.25 USDC → $73.34; 2026-06-24: 0.27 SOL @ $69.30 + 19.41 USDC → $38.12 | **$111.46** |
| **Total** | | | **$174.35** |

**This $174.35 matches the top of the "~$38–$174" the analytics page shows.** The `$38` low
end is literally the single 2026-06-24 SOL claim — i.e. the range is a **partial-render /
partial-resolution artifact**, not a valuation error. When both position activity routes
resolve, Orca lifetime fees = **~$174**, and that is **correct** for the visible positions.

### 1b. Closed positions (Helius-gated)

Sprint 3 Phase A established Account 1 has **18 closed Orca positions** (2 "real" sheet
positions + 15 re-range artifacts netting ≈$0 + 1 omitted Nov-2025 SOL/USDC). Their NFTs are
**burned on close**, so `getNftMints`'s `amount===1` filter can't see them and their position
PDAs are never derived → their `collect_fees` history is unreachable without scanning the
**wallet's** full program-instruction history (the paid-Helius N+1 `getSignaturesForAddress`
→ `getTransaction` backfill that Phase A empirically confirmed 429-storms the free tier).

**Locked-behind-Helius estimate:** ~$2,370 (Osho's record) − ~$174 (open lifetime) ≈
**$2,196**. (Magnitude is what matters; the exact figure depends on Osho's sheet.)

---

## 2. ZEC mint bug (`orca/route.ts:34`)

**Confirmed still present.** Line 34 hardcodes `zRwbzAUoaJABQdvBwZj3YGxiSWjAL2jNX2PBXEBfkMt`
(`symbol ZEC, decimals 8, coingeckoId 'zcash'`). **This is the wrong token.** Osho's actual
on-chain ZEC mint (read live from pool `GTHKH8s8…` tokenMintA) is
**`A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS`**.

**What actually breaks because of it — surprisingly little, today:** because Osho's real mint
is `A7bdiYdS…` (not in `KNOWN_TOKENS`), the wrong `zRwbz…` entry is **never looked up** for
his position — it's **inert dead config**. His ZEC position falls through to the DAS →
`resolveToken` fallback, which I exercised live:

- **Real ZEC `A7bdiYdS…` via the app resolver:** `symbol=ZEC, decimals=8,
  cgId=omnibridge-bridged-zcash-solana, priceable=true` → **spot $459.04**. DeFiLlama-by-mint:
  current **$461.13**, historical (2026-07-01) **$400.73**. **Prices correctly.**
- **Wrong ZEC `zRwbz…` via resolver:** `unresolvable, decimals defaulted to 0, price $0`.
  DeFiLlama: `null`. (Confirms it's a bogus/dead mint.)

So the **open ZEC position value and its fee-claim USD are correct today** — via the resolver
and DeFiLlama-by-real-mint, not via the wrong hardcoded entry.

**Why it's still worth fixing (robustness, not $ recovery):**
- The correct ZEC decimals (8) currently ride on **DAS returning decimals** for `A7bdiYdS…`.
  DAS did return `dec 8` in this run, but a DAS miss would default to 9 and make the ZEC fee
  amount **10× too small**. Pinning the correct mint removes that fragility.
- The `'zcash'` cgId in the dead entry is also wrong for this asset (the real one is
  `omnibridge-bridged-zcash-solana`); leaving it invites a future foot-gun if anything ever
  keys off it.

**Architectural fix direction (Protocol Correctness Contract invariant (i) — "value by the
on-chain mint, never a hardcoded map"):** **delete** the wrong `zRwbz…` line; do **not** trust
a hardcoded map. The resolver already prices the real mint. If a deterministic-decimals pin is
wanted for this longer-tail token, add the **verified** mint `A7bdiYdS…` to
`app/lib/tokenConstants.ts` (`symbol ZEC, decimals 8, cgId omnibridge-bridged-zcash-solana`) —
identity only; pricing stays via the existing cgId→CoinGecko / DeFiLlama-by-mint paths.

**$ impact for Osho: ≈ $0** (already resolves). Value is correctness-hardening + landmine removal.

---

## 3. Placeholder ORCA mint bug

**Confirmed, and worse than "placeholder" — it's an INVALID pubkey.** `getAsset` on
`orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1ABCDE` returns **"Pubkey Validation Err … is invalid"**
(as does the `…uGZE` form cited in the Sprint 3 notes — also invalid as typed). So the entry
can **never match any real on-chain mint**; it is pure dead placeholder.

**Two locations (not one):**
- `app/api/orca/route.ts:26`
- `app/api/solana/balances/route.ts:20`

Both map the invalid `…ABCDE` string to `{symbol: ORCA, decimals: 6, coingeckoId: 'orca'}`.

**Osho impact:** **none** — neither account holds the ORCA token, and no pool in the 2 open
positions involves it. This is a **latent bug for ORCA holders worldwide** (Orca emits ORCA as
a reward token). Per "world's best tracker for all users," still worth cleaning up.

**Architectural fix direction (same invariant (i)):** remove the invalid entry from both files;
resolve ORCA by its **verified real on-chain mint** through the resolver (identity), pricing via
cgId `orca`. Note: DeFiLlama-by-mint returned `null` for the ORCA candidates, so an ORCA-side
fee claim in the Solana activity route (which today prices **only** via DeFiLlama-by-mint) could
go *pending* — see §4/§6 for the CoinGecko-historical fallback that would cover cgId-priceable
tokens like ORCA.

---

## 4. Open-position fee aggregation

**Are open Orca fees flowing into analytics Fee Income correctly? — Yes.**

- The dashboard route (`app/api/orca/route.ts`) passes the **real on-chain mints** as
  `token0Address/token1Address` (= `pool.tokenMintA/B`). `buildActivityUrl` (`useLpPnl.ts:270`)
  forwards them as `mintA/mintB` to `/api/orca/activity`, which reconstructs deposits /
  withdrawals / **fee claims** by scanning the **position PDA's** signatures and values each
  claim at **DeFiLlama historical-by-mint** on the claim date (Rule 1a — claim-date only, never
  spot). Because it keys off the real mint, the ZEC entry bug in §2 does **not** corrupt this.
- My independent free-tier reconstruction (§1a) = **$174.35**, matching the analytics ceiling.
  So open-position claimed fees are **correct and complete**, and **fully free-tier** (the PDA
  scan is bounded — 2–3 signatures per open position here).

**One genuine free-tier robustness gap (why analytics dips to ~$38):** the Solana Orca claim
pricer uses **DeFiLlama-by-mint only** — there is **no CoinGecko-historical fallback** (unlike
the Sui routes, which do CG-historical → DeFiLlama). If DeFiLlama momentarily misses a
mint/date under concurrent load, that claim goes **pending** and drops out of the confident
Orca total → the number sags toward $38 until it refills. Adding a CG-historical co-tier for
tokens that have a cgId (SOL→`solana`, ZEC→`omnibridge-bridged-zcash-solana`) would **stabilize
the already-correct ~$174** (Rule 1c: two historical sources, still never spot). This is
reliability, not new dollars.

**Claimed-while-open vs closed:** every fee claim that happened *while a position's NFT is
still alive* is captured by the PDA scan (free-tier). Fees claimed on **now-closed** positions
are not — that's the §1b Helius-gated bucket.

---

## 5. Cross-check — other Solana token maps

Audited every Solana `KNOWN_TOKENS`/`TOKENS` map for wrong/placeholder mints:

| File | Map | Finding |
|---|---|---|
| `app/api/orca/route.ts` | `KNOWN_TOKENS` | ⛔ ORCA `…ABCDE` (invalid pubkey); ⛔ ZEC `zRwbz…` (wrong token) |
| `app/api/solana/balances/route.ts` | inline map | ⛔ ORCA `…ABCDE` (invalid pubkey) — **second location** |
| `app/api/raydium/route.ts` | `TOKENS` | ✅ no placeholder/invalid mints (no ORCA/ZEC entries) |

**Legacy-but-valid (not placeholders, low priority):** both `orca/route.ts` and
`raydium/route.ts` carry `9n4nbM75…` (labeled WBTC→`bitcoin`; on-chain = soBTC/Sollet, valid,
symbol "BTC", dec 6) and `7vfCXTUXx5…` (labeled ETH→`ethereum`; on-chain = Wormhole WETH, valid,
dec 8). These are real deprecated wrapped assets priced ~1:1 at BTC/ETH — acceptable, but ideal
to migrate to resolver-by-mint eventually (Rule 9 cleanup, no known user impact). RENDER
(`rndriz…`) and Fartcoin (`9BB6…pump`) validated real on-chain. **No other bad mints found.**

---

## 6. Ranked Phase B plan (free-tier only)

Ordered by value-for-effort. **All additive; all value-by-on-chain-mint (invariant (i)); no
per-chain branches; historical-only for claims (Rule 1a).**

**B1 — Remove the wrong ZEC + invalid ORCA hardcoded entries; resolve by on-chain mint.**
- Files: `app/api/orca/route.ts` (lines 26 ORCA, 34 ZEC), `app/api/solana/balances/route.ts`
  (line 20 ORCA). Optionally pin the **verified** real ZEC mint `A7bdiYdS…`
  (`ZEC / dec 8 / omnibridge-bridged-zcash-solana`) in `app/lib/tokenConstants.ts` for
  deterministic decimals.
- $ recovered for Osho: **≈ $0** (ZEC already resolves; no ORCA holding).
- Correctness gain for others: removes an **invalid** ORCA mapping platform-wide (2 files) and a
  wrong ZEC mapping; makes ZEC decimals deterministic instead of DAS-dependent.
- Verification: `resolveToken('solana', A7bdiYdS…)` → priceable ZEC dec 8 (shown: $459.04);
  ZEC/USDC open position value + lifetime $62.89 unchanged; ORCA no longer maps to an invalid
  key; `npm run build` + tsc clean.

**B2 — Add a CoinGecko-historical co-tier to the Orca (Solana) fee-claim pricer.**
- File: `app/api/orca/activity/route.ts` — where a non-stable side today calls
  `getCachedOnlyDefillamaPrice` only, add a CG-historical-by-cgId fallback (resolve mint→cgId
  via resolver; SOL/ZEC/ORCA all have cgIds) **before** marking a claim pending. Rule 1c
  (two historical sources), Rule 1a preserved (no spot). Mirrors the Sui pattern.
- $ recovered for Osho: **stabilizes the intermittent ~$136** (stops the Orca total sagging to
  ~$38); ceiling stays ~$174 (no *new* money).
- Verification: Orca lifetime resolves to **~$174** consistently across repeated loads; a forced
  DeFiLlama miss now falls to CG-historical instead of pending; 0 `fee_claim_resolution
  source=unknown` for SOL/ZEC claims.

**B3 — (Cleanup, optional) migrate the legacy soBTC/Wormhole-ETH map entries to resolver-by-mint.**
- Files: `orca/route.ts`, `raydium/route.ts`. No known user impact; Rule 9 hygiene. Ship only
  if bundling with B1.

### Definitively deferred to the Helius-gated Sprint 3 (closed positions)
- **Closed Orca position fee + Capital-G/L recovery (≈ $2,196 locked).** Requires the paid
  Helius Developer tier ($49/mo, 50 RPS) to scan the **wallet's** full program-instruction
  history and reconstruct the 18 burned-NFT positions (free tier 429-storms it — Phase A
  proven). No free-tier path exists: the position PDAs are underivable once the NFT is burned.
  When it ships it must inherit B1's value-by-on-chain-mint + B2's historical-only cascade from
  day one. **Not in scope for ORCA-FREE-FIX.**

### Overall verification targets for the free-tier sprint
1. ZEC/USDC open position: value + lifetime $62.89 + uncollected ~$51 unchanged; no dependence
   on the deleted `zRwbz…` entry.
2. SOL/USDC open position: lifetime $111.46 unchanged.
3. Orca analytics Fee Income stabilizes at **~$174** (no dips to ~$38) after B2.
4. No invalid/placeholder mint remains in any Solana map (grep `ABCDE`, `zRwbz` → 0 hits).
5. `npm run build` + tsc clean; no cache-version bump needed for B1 (identity-only, values
   byte-identical); B2 changes cached claim USD only on previously-pending claims → bump
   `momentum/orca`-style route cache is in-process (clears on deploy) — confirm at implementation.

---

## Appendix — methods & caveats

- **RPC:** existing **free-tier** Helius key (the current plan) for bounded account reads
  (`getTokenAccountsByOwner`, `getMultipleAccounts`, `getAccountInfo`, `getAsset(Batch)`) and a
  **bounded** per-position-PDA signature scan (2–3 sigs each). **No full-wallet tx backfill** —
  that is the paid-tier operation and was not run.
- **Pricing lookups** were read-only against DeFiLlama (`/prices/historical`, `/prices/current`)
  and the app's own `resolveToken` + `fetchCachedCoinGeckoPrices` (exercised live, not mocked).
- **Scratchpad-only diagnostics** (outside the repo, not committed): `orca-enum.ts`,
  `orca-fees.ts`, `resolver-test.ts`, `pending-orca.ts`, `validate-mints.ts`. No repo files were
  modified; no build was run.
- **SOL uncollected** used a ~$150 SOL placeholder for the pending USD estimate; the ZEC figures
  and all **lifetime** figures use real DeFiLlama historical/current prices.
