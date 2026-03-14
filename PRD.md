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
- Read-only watch addresses — not needed given current wallet setup
- Historical IL tracking — no on-chain transaction history queries

---

## Implementation Priority

```
1. Feature 1: IL Calculator
   a. Add liquidity/price0/price1 to all 9 API routes
   b. IL section on detail page
   c. Total IL tile on dashboard

2. Feature 2: Wallet badges
   a. Add walletAddress to all API routes
   b. Badge on position card
   c. Hide logic when ≤1 wallet

3. Feature 3: Protocol integrations (as separate sessions per protocol)
```
