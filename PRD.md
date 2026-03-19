# LP Tracker — Product Requirements Document

_Last updated: 2026-03-15_

---

## Feature 0: Bug Fixes — DONE ✅

All critical bugs resolved in prior sessions.

| Bug | Resolution |
|-----|-----------|
| Wallet auto-connect when locked | `WalletAuthContext` stores `solanaAddress`/`suiAddress` — only set after explicit user consent. Wallet Standard silent reconnect never leaks into display state. |
| Closed positions not appearing | Positions with 0 liquidity whose NFT/object still exists on-chain show as "Closed". Fully burned NFTs (Solana) and destroyed position objects (Sui/EVM) cannot be recovered — an info note in the dashboard explains this when Solana/Sui wallet is connected. |

---

## Feature 1: Impermanent Loss Calculator

### Overview

Show impermanent loss (IL) for each active concentrated liquidity position — on the detail page as a full breakdown, and as a 4th aggregate stat tile on the dashboard summary row.

### Scope

- **In scope:** All V3-style CLMM positions that have `tickLower`, `tickUpper`, `liquidity`, and known token prices (virtually all current integrations).
- **Out of scope:** Aerodrome/Velodrome v2 pairs (no tick range). Classic AMM positions. Closed positions (liquidity = 0 — cannot compute meaningful entry amounts).

---

### 1.1 Entry Price Derivation

Entry price is **auto-detected** from the geometric midpoint of the position's tick range. No manual input required.

```
entryTick  = floor((tickLower + tickUpper) / 2)
sqrtPe     = sqrt(1.0001 ^ entryTick)          // sqrt of raw price ratio (token1_raw / token0_raw)
sqrtLower  = sqrt(1.0001 ^ tickLower)
sqrtUpper  = sqrt(1.0001 ^ tickUpper)

// Human-readable USD price of token0 at entry:
entryPriceToken0USD = sqrtPe² × 10^(decimals0 − decimals1) × price1USD
```

This is a reasonable proxy for where the user opened the position (the range midpoint is the most neutral LP entry assumption). It will be labeled as "estimated" in the UI.

---

### 1.2 IL Formula — "Actual Entry Split" Basis

Rather than the classic 50/50 HODL assumption, IL is computed against the **actual token split the user would have held** at the entry price (inferred from the range midpoint).

**API changes required** — add to every position response:
- `liquidity: string` — BigInt serialized as decimal string (already computed in all routes, just not returned)
- `price0: number` — current USD price of token0 (already computed, just not returned)
- `price1: number` — current USD price of token1 (already computed, just not returned)

**Calculation (client-side, detail page):**
```
// Entry token amounts (using same liquidity L as current position)
L = Number(position.liquidity)

entryAmount0 = L × (1/sqrtPe − 1/sqrtUpper) / 10^decimals0
entryAmount1 = L × (sqrtPe − sqrtLower)      / 10^decimals1

// What those tokens are worth TODAY if held
hodlValue = entryAmount0 × price0 + entryAmount1 × price1

// IL
ilUSD  = position.value − hodlValue          // negative = loss
ilPct  = (ilUSD / hodlValue) × 100

// Show if liquidity > 0 and hodlValue > 0
```

**Edge cases:**
- If `liquidity = 0` (closed): hide IL entirely — show "—"
- If `hodlValue ≤ 0` or `sqrtPe` is NaN/Infinity: hide IL — show "—"
- If price0 or price1 is 0 (unknown token): hide IL — show "—"

---

### 1.3 UI — Detail Page

Add an "Impermanent Loss" section to `/dashboard/[id]`, **alongside** the existing Est. Daily Fees / Monthly Yield section (do not replace).

```
┌─────────────────────────────────────────────┐
│  Impermanent Loss                           │
│  ─────────────────────────────────────────  │
│  Entry price (est.)    ~$30.37 / HYPE       │
│  HODL value            $8,252               │
│  Current value         $8,110               │
│  IL                    −$142  (−1.8%)       │
│                                             │
│  Based on range midpoint · tick −242,330    │
└─────────────────────────────────────────────┘
```

- IL dollar amount in red if negative, green if positive (price moved favorably)
- Small grey footnote: "Estimated from range midpoint — not your actual entry"

---

### 1.4 UI — Dashboard Stat Tile (4th tile)

Add a 4th tile to the existing stats row: **Total Value · Total Fees · Positions · Total IL**

```
[ Total Value ] [ Total Fees ] [ Positions ] [ Total IL  ]
  $24,500         $187           5             −$340 (−1.4%)
```

- Aggregate `ilUSD` and `hodlValue` across all positions where IL is calculable
- `totalILPct = sum(ilUSD) / sum(hodlValue) × 100`
- Tile text red if negative, grey/hidden if no calculable positions

---

### Acceptance Criteria

- [ ] Detail page shows IL section with entry price, HODL value, current value, IL $, IL %
- [ ] IL section is absent (not "0") for closed positions and unknown-price tokens
- [ ] Dashboard shows 4th stat tile "Total IL" aggregating across all calculable positions
- [ ] All 9 active protocol routes (Aerodrome, Uni V3, Velodrome, Raydium, Orca, Cetus, Bluefin, Momentum, HyperSwap) return `liquidity`, `price0`, `price1` in response
- [ ] Build passes (`npm run build`) with no TypeScript errors

---

## Feature 2: Wallet Address Badges on Position Cards

### Overview

Each position card shows a subtle **last-4-chars wallet badge** so the user can instantly see which wallet owns it. This improves the combined EVM+Solana+Sui view when all three wallets are connected simultaneously.

### Scope

No new wallet connection logic is needed. The existing trio (EVM via wagmi, Solana via WalletAuthContext, Sui via WalletAuthContext) is sufficient. This is purely a display enhancement.

---

### 2.1 Data Flow

1. Each API route already receives `account` as a query param — include `walletAddress: account` in the position response.
2. `AerodromePosition` type gets an optional `walletAddress?: string` field.
3. Each lib wrapper (`app/lib/*.ts`) passes the account to the API and the response already has `walletAddress` in it (via the spread).
4. Dashboard card reads `pos.walletAddress` and renders the badge.

---

### 2.2 UI — Position Card Badge

```
┌──────────────────────────────────────────────────────┐
│  HYPE / USDC          ●In Range                      │
│  ProjectX  ·  HyperEVM  ·  0.05%    ...8d0C         │
│  Value: $8,110    APY: 50%    Fees: $31              │
└──────────────────────────────────────────────────────┘
```

- Badge: `...{last4}` in `text-gray-500 text-xs` at the top-right or inline after the chain
- For EVM: last 4 hex chars of address (e.g., `...F20`)
- For Solana: last 4 base58 chars (e.g., `...ogC`)
- For Sui: last 4 hex chars (e.g., `...3f4a`)
- Badge hidden if only one wallet is connected (no ambiguity)

---

### Acceptance Criteria

- [ ] Each position response includes `walletAddress`
- [ ] Dashboard card shows `...{last4}` badge
- [ ] Badge hidden when ≤1 wallet is connected
- [ ] Build passes with no TypeScript errors

---

## Feature 3: Future Protocol Integrations

Planned integrations in rough priority order. Each follows the **New Chain Integration Checklist** in CLAUDE.md.

### Phase A — More EVM DEXes

| Protocol | Chain | Notes |
|----------|-------|-------|
| Camelot V3 | Arbitrum | Custom NonfungiblePositionManager; spNFT staking pattern |
| Trader Joe V2 | Avalanche / Arbitrum | Liquidity Book (bin-based), not tick-based — different math |
| SushiSwap V3 | Multi-chain | Standard Uni V3 fork; NonfungiblePositionManager per chain |

For each: new route at `app/api/{protocol}/route.ts`, lib wrapper, add to PositionsContext.

### Phase B — Solana DEXes

| Protocol | Notes |
|----------|-------|
| Orca Whirlpools v2 | Check if new position type differs from current whirlpools implementation |
| Jupiter Liquidity Pools | Research Jupiter concentrated liquidity product; may not have on-chain user positions |
| Drift Protocol | Vaults / liquidity; different position model — research required |

### Phase C — More Sui DEXes

| Protocol | Notes |
|----------|-------|
| Turbos Finance | CLMM on Sui; similar object model to Cetus |
| FlowX | Concentrated liquidity; check position object type |
| DeepBook | Order book AMM; fundamentally different from CLMM — research required |

### Integration Requirements (all protocols)

- Follow CLAUDE.md checklist: raw RPC/fetch, no chain SDK in API routes, manual binary/object decode
- Return `AerodromePosition[]` shape
- Include `liquidity`, `price0`, `price1`, `walletAddress` in response (consistent with Features 1 & 2)
- All positions with liquidity = 0 returned as `status: 'Closed'`
- APY from DefiLlama if indexed; 0% if not (do not fabricate)
- Pending fees: use feeGrowthInside math for V3 forks; settled fees only for others
- Add to PositionsContext after confirmed working

---

## Non-Goals (explicitly out of scope for now)

- Mobile UI polish — deferred until higher priority items are complete
- Manual entry price override for IL — auto midpoint is sufficient
- Multiple simultaneous EVM wallets — current one-EVM-at-a-time is sufficient
- Historical IL tracking — no on-chain transaction history queries

---

## Implementation Priority (Phase 1)

```
1. Feature 1: IL Calculator ✅
2. Feature 2: Wallet badges ✅
3. Feature 3: Protocol integrations — DEFERRED (no active positions)
```

---

---

# Phase 2: Multi-Chain Expansion + Watch Wallet

_Last updated: 2026-03-16_

## Priority Order

```
4. Feature 4: PancakeSwap V3 (BNB Chain)
5. Feature 5: Watch Wallet
6. Feature 6: Aptos + Liquidswap/Thala (speculative — no positions yet)
```

Trader Joe V2 removed from scope (user has no positions and Liquidity Book math is complex).

---

## Feature 4: PancakeSwap V3 (BNB Chain)

### Overview

Add BNB Chain support via PancakeSwap V3 — a direct Uni V3 fork. Reuse the existing pattern from `app/api/uniswap/v3/route.ts` with BSC-specific contract addresses and an Alchemy BSC RPC key.

### Technical Details

- **NFT Manager**: `0x46A15B0b27311cedF172AB29E4f4766fbE7F4364` (verified on BscScan)
- **Factory**: `0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865`
- **RPC**: `https://bnb-mainnet.g.alchemy.com/v2/${NEXT_PUBLIC_ALCHEMY_KEY}` — same existing key, no new env var needed
- **Chain ID**: 56
- **Chain name**: `BNB Chain`
- **Native token**: BNB
- **DefiLlama project**: `pancakeswap-v3`, chain `BSC`
- **positions() selector**: Standard Uni V3 `0x99fd0e82` (PancakeSwap V3 is a true fork)
- **Token resolution**: Hardcode common BSC tokens (WBNB, USDT, USDC, BUSD, CAKE, ETH, BTCB); fallback to `eth_call` `symbol()/decimals()` for unknowns
- **No new env var needed** — Alchemy supports BNB Chain with the existing `NEXT_PUBLIC_ALCHEMY_KEY`

### Implementation Steps

1. Create `app/api/pancakeswap/route.ts` — copy Uni V3 pattern, swap in BSC addresses + RPC
3. Create `app/lib/pancakeswap.ts` — thin fetch wrapper
4. Add to `PositionsContext.tsx` — fires when EVM wallet connected (BSC positions share EVM wallet)
5. Update `KNOWN_TOKENS` map with BSC token addresses
6. Verify `positions()` selector matches standard Uni V3 (or patch if different)
7. Add to `progress.txt` + commit

### Acceptance Criteria

- [ ] `app/api/pancakeswap/route.ts` returns positions for BSC wallet
- [ ] Positions appear on dashboard with protocol "PancakeSwap V3" and chain "BNB Chain"
- [ ] APY from DefiLlama (0% if not indexed is acceptable)
- [ ] IL calculator works (liquidity, price0, price1 included in response)
- [ ] walletAddress included in response
- [ ] Build passes with no TypeScript errors

---

## Feature 5: Watch Wallet

### Overview

Let the user paste any wallet address + select a chain to watch LP positions from any wallet — without connecting it. Watched wallets' positions are mixed into the main dashboard alongside connected wallets. Watched wallets are saved to localStorage and persist across sessions.

### Scope

- **No limit** on number of watched wallets
- **Supported chains for watching**: EVM (all current chains incl. BNB), Solana, Sui, Aptos (placeholder — no integration yet)
- Watched positions appear in the **main dashboard** (not a separate tab)
- Wallet address badges (`...{last4}`) already implemented — watched wallets will show their badge naturally
- Watched wallets are **read-only** — no connect/disconnect, just data fetching

### 5.1 Data Model

```ts
// localStorage key: "lp-watched-wallets"
type WatchedWallet = {
  address: string        // full address string
  chain: 'evm' | 'solana' | 'sui' | 'aptos'
  label?: string         // optional user-set nickname
  addedAt: number        // timestamp
}
```

### 5.2 Quick-Add UI (Dashboard)

Input bar below the stats row, always visible:

```
[ Total Value ] [ Total Fees ] [ Positions ] [ Total IL ]
────────────────────────────────────────────────────────
👁  0x1234abcd...  [Chain ▾]  [Watch]
────────────────────────────────────────────────────────
  Position cards...
```

- Text input: placeholder "Paste wallet address"
- Chain dropdown: EVM / Solana / Sui / Aptos
- "Watch" button: validates address format, saves to localStorage, triggers refetch
- Shows inline error if address format doesn't match selected chain
- Collapses/hides if no watched wallets and user hasn't focused it (optional UX improvement)

### 5.3 Watched Wallets Management Page (`/watched`)

Dedicated page listing all watched wallets:

```
Watched Wallets

  EVM   0xAbCd...1234   (optional label)   [Remove]
  SOL   GndR...ogC      My Solana wallet   [Remove]
  SUI   0xef...3f4a                        [Remove]

  [ + Add wallet ]
```

- Remove button deletes from localStorage + triggers refetch
- Optional inline label editing
- Linked from Navbar ("Watched" link or icon)

### 5.4 Data Fetching Integration

- `WatchedWalletsContext` (new context) — reads from localStorage, exposes `watchedWallets[]` and `addWallet/removeWallet`
- `PositionsContext` imports `WatchedWalletsContext` — for each watched wallet, calls the matching API route(s) and pushes to the positions array
- EVM watched wallets: call Aerodrome, Uni V3, Velodrome, HyperSwap, PancakeSwap routes with the watched address
- Solana watched wallets: call Raydium + Orca routes
- Sui watched wallets: call Cetus + Bluefin + Momentum routes
- Positions from watched wallets get `walletAddress` set to the watched address — badge shows naturally

### Acceptance Criteria

- [ ] Quick-add bar on dashboard accepts address + chain, saves to localStorage
- [ ] Watched wallet positions appear mixed into main dashboard
- [ ] Wallet address badges distinguish watched vs connected wallets visually (same badge, different source)
- [ ] `/watched` page lists all watched wallets with remove button
- [ ] Removing a wallet instantly removes its positions from the dashboard
- [ ] Watched wallets persist across page refresh
- [ ] No limit enforced — many watched wallets work
- [ ] Build passes with no TypeScript errors

---

## Feature 6: Aptos + Liquidswap / Thala (Speculative)

### Overview

Add Aptos chain support. No active positions yet — build it ready for future use. Lower priority; skip if no positions by the time Features 4 and 5 are done.

### Technical Details (to be researched before building)

- **Wallet adapter**: `@aptos-labs/wallet-adapter-react` (official Aptos wallet standard)
- **Liquidswap**: Pontem Network CLMM on Aptos — position module TBD (research required)
- **Thala**: Thala Labs AMM on Aptos — position module TBD (research required)
- **RPC**: Aptos public fullnode `https://fullnode.mainnet.aptoslabs.com/v1` (no key needed)
- **Position fetching**: Aptos REST API (`/accounts/{address}/resources`, `/accounts/{address}/events`) — no binary decoding, JSON REST
- **DefiLlama**: chain `Aptos`, project names TBD

### Status

Speculative — no positions to test against. Research phase required before planning. **Do not build until user has active Aptos positions.**

---

## Phase 2 Non-Goals

- Mobile UI polish — still deferred
- Trader Joe V2 (Liquidity Book) — removed (no positions, complex math)
- Multiple simultaneous EVM wallets — still one-EVM-at-a-time
- Watch wallet notifications / alerts — out of scope

---

## Phase 2 Implementation Priority

```
4. Feature 4: PancakeSwap V3 (BNB Chain)
   a. ALCHEMY_BSC_KEY env var
   b. app/api/pancakeswap/route.ts
   c. app/lib/pancakeswap.ts
   d. Wire into PositionsContext

5. Feature 5: Watch Wallet
   a. WatchedWalletsContext + localStorage
   b. Quick-add bar on dashboard
   c. /watched management page
   d. PositionsContext integration (fetch for each watched wallet)

6. Feature 6: Aptos (only if user opens positions)
```

---

---

# Phase 3: Position Activity & Analytics

_Last updated: 2026-03-17_

## Overview

Add on-chain transaction history and real performance metrics to position detail pages. Start with **Aerodrome on Base only** — expand to other protocols after this is confirmed working.

Three new sections appear at the bottom of `/dashboard/[id]` for Aerodrome positions, below the existing IL and Fee Estimate sections.

---

## Feature 7: Current vs Invested Assets (Section 1)

### What it shows

```
┌─────────────────────────────────────────────────────────┐
│  Assets                                                 │
│  ─────────────────────────────────────────────────────  │
│                    Token0         Token1       Total    │
│  Invested     1.24 WETH      420 USDC        $4,312     │
│  Current      1.31 WETH      398 USDC        $4,501     │
│  Gain/Loss   +0.07 WETH      −22 USDC        +$189      │
└─────────────────────────────────────────────────────────┘
```

- **Invested**: sum of all `IncreaseLiquidity` events (amount0 + amount1) minus sum of all `DecreaseLiquidity` events. Represents net tokens deposited to date.
- **Current**: existing `amount0` / `amount1` computed by the API route (already shown in position detail).
- **Gain/Loss**: Current − Invested, per token and in USD at current prices.
- USD values for invested amounts use **current prices** (not historical) — simpler, still useful for relative comparison.
- Show for all positions including Closed.

---

## Feature 8: Activity History Table (Section 2)

### What it shows

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Activity History                                                          │
│  ──────────────────────────────────────────────────────────────────────── │
│  Date          Action          Token0        Token1        USD      Cumul. │
│  2026-01-04    Deposit         1.24 WETH     420 USDC      $4,312   —      │
│  2026-01-15    Fee Claim       0.003 WETH    12 USDC       $24      $24    │
│  2026-02-01    Fee Claim       0.005 WETH    18 USDC       $38      $62    │
│  2026-03-10    Fee Claim       0.004 WETH    14 USDC       $29      $91    │
└────────────────────────────────────────────────────────────────────────────┘
  Tx hash links open BaseScan in new tab
```

- **Rows**: Deposit (IncreaseLiquidity), Fee Claim (Collect), Withdrawal (DecreaseLiquidity), Close (all liquidity removed)
- **Sorted**: newest first
- **USD value at time of tx**: fetched from CoinGecko `/coins/{id}/history?date=DD-MM-YYYY` for each unique date in the tx history
- **Cumulative fees**: running total of all fee claims in USD (resets at zero, not decremented by withdrawals)
- Tx hash displayed as `0x1234...abcd` linking to `https://basescan.org/tx/{hash}`

### Events to scan

Aerodrome CL positions involve two contracts. Both are scanned:

| Contract | Event | Description |
|----------|-------|-------------|
| NonfungiblePositionManager | `IncreaseLiquidity(tokenId, liquidity, amount0, amount1)` | Deposit / top-up |
| NonfungiblePositionManager | `DecreaseLiquidity(tokenId, liquidity, amount0, amount1)` | Partial or full withdrawal |
| NonfungiblePositionManager | `Collect(tokenId, recipient, amount0, amount1)` | Fee claim |
| CL Gauge | `Deposit(address from, uint256 tokenId)` | NFT staked in gauge (no amounts, correlate to IncreaseLiquidity by block) |
| CL Gauge | `Withdraw(address from, uint256 tokenId)` | NFT unstaked |

> Note: `Collect` on the NonfungiblePositionManager captures the actual token amounts for fee claims. Gauge events (`Deposit`/`Withdraw`) provide staking timestamps for context only.

### Data source

- **RPC**: `eth_getLogs` via existing Alchemy key (`NEXT_PUBLIC_ALCHEMY_KEY`), Base chain (`https://base-mainnet.g.alchemy.com/v2/${key}`)
- **Block range**: from block 0 (Base genesis) to `latest` — full history, no cap
- **Filter**: by contract address + event topic0 (keccak256 of event signature) + tokenId as topic
- The Sugar V3 contract already returns a `gauge` field per position — pass it through in `/api/aerodrome` response as `gauge?: string` on the position object
- The NonfungiblePositionManager address is already known: standard Aerodrome CL NFT manager on Base

### New API route

`GET /api/aerodrome/activity?positionId={nftId}&gauge={0x...}&token0={0x...}&token1={0x...}&account={0x...}`

Returns:
```ts
{
  events: ActivityEvent[]
  totalFeesClaimed: { amount0: string, amount1: string, usd: number }
  daysActive: number
}

type ActivityEvent = {
  type: 'deposit' | 'fee_claim' | 'withdrawal' | 'close'
  txHash: string
  blockNumber: number
  timestamp: number          // unix seconds
  amount0: string            // decimal string
  amount1: string
  usdAtTime: number | null   // null if CoinGecko lookup fails
  cumulativeFeeUSD: number   // running total (fee_claim rows only)
}
```

### Caching

- Cache key: `aero-activity-${positionId}` in localStorage
- TTL: 5 minutes
- On cache hit: return cached data immediately, show "Updated X ago" caption
- On cache miss or expiry: fetch fresh, show loading spinner

---

## Feature 9: Actual APR (Section 3)

### What it shows

```
┌─────────────────────────────────────────────────────────┐
│  Actual Performance                                     │
│  ─────────────────────────────────────────────────────  │
│  Total fees earned       $91                            │
│  Position active         68 days                        │
│  Realized APR            ~194% / yr                     │
│                                                         │
│  Daily   $1.34   Monthly  $40.5   Yearly  $489          │
│                                                         │
│  Based on actual claimed fees · not pool APY estimate   │
└─────────────────────────────────────────────────────────┘
```

### Formula

```
totalFeesUSD = sum of all fee_claim rows (usdAtTime, fallback to current price)
daysActive   = (now − firstDepositTimestamp) / 86400
realizedAPR  = (totalFeesUSD / currentPositionValue) / (daysActive / 365) * 100

dailyFees    = totalFeesUSD / daysActive
monthlyFees  = dailyFees * 30
yearlyFees   = dailyFees * 365
```

- Show for **all positions including Closed** (realized APR is the most meaningful metric for closed positions)
- If `daysActive < 1`: show "< 1 day active" and omit APR (too early to annualize)
- If `totalFeesUSD = 0`: show "No fees claimed yet" instead of 0% APR
- Sits **alongside** the existing "Est. Daily Fees / Monthly Yield" section — labeled clearly as "Actual" vs "Estimated (pool APY)"

---

## Technical Implementation Plan

### Step 1 — Pass gauge address through Aerodrome route
- Sugar V3 decode already has `gauge` in the raw response; add `gauge?: string` to `AerodromePosition` type and return it from `/api/aerodrome`

### Step 2 — Build `/api/aerodrome/activity` route
- Accept: `positionId`, `gauge`, `token0`, `token1`, `account` query params
- Scan eth_getLogs on NonfungiblePositionManager for IncreaseLiquidity/DecreaseLiquidity/Collect filtered by tokenId
- Scan eth_getLogs on gauge for Deposit/Withdraw filtered by tokenId
- Decode event data (no ethers/viem — manual ABI decode)
- Fetch block timestamps via `eth_getBlockByNumber` (batch if possible)
- Fetch historical CoinGecko prices per unique date in the event list
- Compute cumulative fees + daysActive + totalFeesClaimed
- Return structured `ActivityEvent[]`

### Step 3 — Client-side caching layer (`app/hooks/usePositionActivity.ts`)
- localStorage cache with 5-min TTL
- Loading / error states
- Fetches from `/api/aerodrome/activity` using position fields already on the detail page

### Step 4 — UI on `/dashboard/[id]`
- Section 1: Assets table (invested vs current vs gain/loss)
- Section 2: Activity history table with BaseScan links
- Section 3: Actual APR panel
- All three sections gated: only render for Aerodrome positions (`pos.protocol === 'Aerodrome'`)

---

## Edge Cases

| Case | Handling |
|------|----------|
| Position opened before Base genesis indexing | Scan from block 0; Alchemy handles gracefully |
| CoinGecko rate limit on historical prices | Retry with exponential backoff; fallback to current price if all retries fail |
| Very old position with 100+ fee claims | Cap CoinGecko calls to 30 unique dates; use current price for older dates |
| Position never staked in gauge (no gauge events) | Only scan NonfungiblePositionManager; still shows IncreaseLiquidity/Collect |
| Partial withdrawals (multiple DecreaseLiquidity events) | Each shown as its own row in history table |
| tokenId not in a top-up (one deposit only) | "Invested" = single IncreaseLiquidity row |
| Alchemy getLogs timeout on full block range | Split into chunks of 500k blocks; aggregate results |

---

## Scope Boundaries (Phase 3)

- **In scope**: Aerodrome (Base) only
- **Out of scope for now**: Uniswap V3, Velodrome, Raydium, Orca, Cetus, Bluefin, Momentum, HyperSwap, PancakeSwap — expand after Aerodrome is confirmed working
- **No new env vars** — uses existing `NEXT_PUBLIC_ALCHEMY_KEY`
- **No database** — localStorage cache only

---

## Acceptance Criteria

- [ ] `/api/aerodrome` response includes `gauge?: string` field
- [ ] `/api/aerodrome/activity` returns correct events for a known Aerodrome position
- [ ] Section 1 (Assets) shows invested vs current with correct gain/loss
- [ ] Section 2 (Activity History) shows all deposit/fee claim/withdrawal rows in newest-first order
- [ ] Each row in Section 2 has a working BaseScan link
- [ ] Section 3 (Actual APR) shows realized APR based on actual claimed fees
- [ ] All three sections visible for both active and closed Aerodrome positions
- [ ] Activity data cached in localStorage with 5-min TTL
- [ ] Sections absent for non-Aerodrome positions (no errors, no empty boxes)
- [ ] Build passes with no TypeScript errors

---

## Phase 3 Implementation Priority

```
7. Feature 7: Current vs Invested Assets (Section 1)
   a. Pass gauge through /api/aerodrome response
   b. Build /api/aerodrome/activity route (event log scanning)
   c. usePositionActivity hook (localStorage cache)
   d. Assets table UI on detail page

8. Feature 8: Activity History Table (Section 2)
   a. Add CoinGecko historical price fetching to /api/aerodrome/activity
   b. Activity table UI with BaseScan links

9. Feature 9: Actual APR (Section 3)
   a. APR calculation from activity data
   b. Actual Performance panel UI
   c. Sits alongside existing Est. Daily Fees section
```

**Do not start building until confirmed by user.**

---

---

# Phase 4: Bluefin Activity Expansion

_Last updated: 2026-03-20_

## Overview

Replicate Features 7, 8, and 9 for **Bluefin on Sui**. Same three sections on the position detail page — Assets (Invested vs Current), Activity History table, and Actual Performance (realized APR) — using Sui's transaction query API instead of EVM `eth_getLogs`.

---

## Technical Approach

### Transaction querying

Use `suix_queryTransactionBlocks` with `filter: { ChangedObject: positionObjectId }` to find all transactions that mutated the position object. This catches deposits, withdrawals, and fee claims without needing to know Bluefin's event type names upfront.

```
suix_queryTransactionBlocks({
  filter: { ChangedObject: positionObjectId },
  options: {
    showEvents: true,
    showBalanceChanges: true
  },
  limit: 50
})
```

Paginate until `hasNextPage = false`. Each result includes:
- `digest` — transaction hash equivalent (base58)
- `timestampMs` — millisecond timestamp (no separate block lookup needed)
- `events[]` — Move events with `type` (full module path) and `parsedJson`
- `balanceChanges[]` — `{ owner, coinType, amount }` for all participants

### Classifying transaction types

Inspect the events array for events from the Bluefin package (`0x3492c874...`). The event `type` field reveals the struct name (e.g. `0x3492...::pool::AddLiquidityEvent`). Exact event names will be discovered empirically from the first live RPC call during Step 1 of building.

Fallback: use `balanceChanges` filtered to the wallet address — if both coins are negative → deposit; both positive → withdrawal or fee claim; distinguish fee claim vs withdrawal by checking whether liquidity field changed (visible in `objectChanges`).

### Amount extraction

Use `balanceChanges` filtered to `owner.AddressOwner === account` — cleaner than parsing event fields and works regardless of event struct layout.

### Timestamps

`timestampMs` is returned directly on each transaction block — no separate `eth_getBlockByNumber` lookup required (simpler than Aerodrome).

### Historical USD prices

Same CoinGecko approach as Aerodrome: `/coins/{id}/history?date=DD-MM-YYYY`, capped at 30 most recent unique dates, fallback to current price. Known Sui coin → CoinGecko ID map: `0x2::sui::SUI` → `sui`, USDC → `usd-coin`, USDT → `tether`, WETH → `ethereum`.

### Transaction links

Each tx links to `https://suivision.xyz/txblock/{digest}` (clean Sui explorer, no network param needed for mainnet).

---

## New API Route

`GET /api/bluefin/activity?positionId={objectId}&account={suiAddr}&coinTypeA={type}&coinTypeB={type}&t0d={n}&t1d={n}&p0={f}&p1={f}`

Returns same `ActivityResponse` shape as `/api/aerodrome/activity` for consistency:

```ts
{
  events: ActivityEvent[]       // same type — usdAtTime, cumulativeFeeUSD
  netInvested0: number
  netInvested1: number
  totalFees0: number
  totalFees1: number
}
```

### Caching

Same localStorage pattern as `usePositionActivity` — 5-min TTL, key: `bluefin-activity-{positionId}`.

---

## Data Flow Changes

### `AerodromePosition` type

Add `coinTypeA?: string` and `coinTypeB?: string` — Sui coin type strings (e.g. `0x2::sui::SUI`). These are the Sui equivalent of EVM token addresses for historical price lookups.

### Bluefin API route (`/api/bluefin/route.ts`)

Add `coinTypeA` and `coinTypeB` to the returned position object (already have them internally as `coinTypeA`/`coinTypeB`).

Also add `account` as `walletAddress` (already done) — but the Sui wallet address also needs to be forwarded to the activity hook so it can filter `balanceChanges`.

### New hook: `app/hooks/useBluefinActivity.ts`

Mirror of `usePositionActivity` — same cache/fetch pattern, different endpoint and params.

---

## UI on `/dashboard/[id]`

Add three sections **below** the existing IL section, **gated by `pos.protocol === 'Bluefin'`**:

1. **Assets** — Invested / Current / Gain-Loss table (same layout as Aerodrome)
2. **Activity History** — table with Date, Action, CoinA, CoinB, USD at time, Cumul. Fees, Tx (links to Suivision)
3. **Actual Performance** — realized APR panel (same as Aerodrome)

---

## Edge Cases

| Case | Handling |
|------|----------|
| Position creation tx not returned by ChangedObject filter | Check objectChanges for "created" type; treat as deposit |
| balanceChanges has unexpected coin types | Skip unknown coins |
| CoinGecko rate limit | Retry once; fallback to current price |
| Multiple deposits / partial withdrawals | Each shown as its own row |
| Sui address not available client-side | Hook accepts null account → skips fetch |

---

## Acceptance Criteria

- [ ] `/api/bluefin` response includes `coinTypeA`, `coinTypeB` fields
- [ ] `/api/bluefin/activity` returns correct events for a known position (all 4 operation types)
- [ ] Assets section shows Invested / Current / Gain-Loss for Bluefin positions
- [ ] Activity History table shows all rows with Suivision tx links
- [ ] Actual Performance panel shows realized APR, daily/monthly/yearly
- [ ] All three sections hidden for non-Bluefin positions
- [ ] localStorage cache with 5-min TTL
- [ ] `suiAddress` forwarded from `WalletAuthContext` to the hook via detail page
- [ ] Build passes with no TypeScript errors

---

## Phase 4 Implementation Order

```
Step 1: Research — make live RPC call to discover Bluefin event type names
   a. Add coinTypeA/coinTypeB to AerodromePosition type + Bluefin API route
   b. Make a test suix_queryTransactionBlocks call on a known position objectId
   c. Record exact event type strings for classify logic

Step 2: Build /api/bluefin/activity/route.ts
   a. suix_queryTransactionBlocks with ChangedObject filter + pagination
   b. Classify events by type string discovered in Step 1
   c. Extract amounts from balanceChanges
   d. CoinGecko historical prices (same cap-30 approach)
   e. Compute cumulativeFeeUSD, netInvested, totalFees

Step 3: Hook + UI
   a. app/hooks/useBluefinActivity.ts (localStorage cache, 5-min TTL)
   b. Detail page: pass coinTypeA/B + suiAddress to hook
   c. Assets section (gated: pos.protocol === 'Bluefin')
   d. Activity History table with Suivision links
   e. Actual Performance panel

Step 4: Test and confirm
   a. Verify all 4 operation types appear correctly
   b. Verify USD values and cumul. fees make sense
   c. npm run build — no TypeScript errors
```

**Do not start building until confirmed by user.**
