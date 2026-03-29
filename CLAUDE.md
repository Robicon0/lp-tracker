# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — Start dev server (Next.js 16, port 3000)
- `npm run build` — Production build
- `npm run lint` — ESLint (flat config, next/core-web-vitals + typescript)
- No test framework is configured

## Architecture

DeFi liquidity position tracker. Next.js 16 App Router with wagmi v3 for wallet connection and on-chain data fetching.

### Data Flow

When a wallet is connected, the dashboard fetches LP positions from three API routes in parallel (`/api/aerodrome`, `/api/uniswap/v3`, `/api/velodrome`). Each route makes raw RPC calls to on-chain contracts via Alchemy, decodes ABI-encoded hex responses manually (no ethers/viem contract abstractions), then enriches with CoinGecko prices and DefiLlama APY data. Without a wallet, 8 hardcoded demo positions from `app/data/positions.ts` are shown.

### API Routes (server-side on-chain fetching)

- `app/api/aerodrome/route.ts` — Reads Aerodrome CL positions on Base via Sugar contract. Decodes packed uint256 fields (15 per position) from raw hex.
- `app/api/uniswap/v3/route.ts` — Reads Uniswap V3 NFT positions on Ethereum/Arbitrum/Polygon/Optimism via NonfungiblePositionManager. Estimates token amounts using sqrt-price tick math.
- `app/api/velodrome/route.ts` — Reads Velodrome CL positions on Optimism via Sugar contract. Same decode pattern as Aerodrome.

All three routes share a common output shape (`AerodromePosition` interface in `app/lib/aerodrome.ts`) with fields: id, pair, protocol, chain, value, apy, fees, status.

### Client Libraries

`app/lib/{aerodrome,uniswap,velodrome}.ts` — Thin fetch wrappers calling the corresponding API routes. All return `AerodromePosition[]` (the shared position type).

### Key Patterns

- **Manual ABI decoding**: API routes decode raw `eth_call` hex responses by slicing 64-char words rather than using library-level contract calls. Token addresses resolved via hardcoded `TOKENS`/`KNOWN_TOKENS` lookup maps per chain.
- **Price enrichment**: CoinGecko for token prices (60s revalidation), DefiLlama yields API for APY data (300s revalidation). Median APY used for token-pair fallback matching.
- **Wallet**: Single injected connector (MetaMask). Config in `app/config/wagmi.ts` supports mainnet, Base, Arbitrum, Optimism, Polygon, Avalanche.
- **Provider wrapping**: `app/providers.tsx` wraps app with WagmiProvider + React Query. All pages using hooks must be `"use client"`.
- **Auto-refresh**: `PositionsContext` uses `refetchInterval: 60_000` + `placeholderData: keepPreviousData` for smooth background refresh with no layout shift. Exposes `isFetching`, `dataUpdatedAt`, `refetch`. Dashboard shows "Updated X ago" + manual refresh button (spinning icon while fetching).
- **Portfolio history**: `app/hooks/usePortfolioHistory.ts` — saves `{timestamp, totalValue, positionCount}` snapshots to localStorage (`lp-portfolio-history`) on every positions refresh (every 60s). Caps at 1000 points (oldest pruned); keeps 30 days by age. Chart shows after ≥2 points (appears within ~1 minute on first load). Range buttons (1D/7D/30D/90D/1Y) filter snapshots; if range has <2 points, falls back to all available data and labels P&L "since [date]". No 24h gate.

### Pages

- `/` — Landing page (server component)
- `/dashboard` — Portfolio overview with filters, search, sort, CSV export, portfolio history chart + P&L (client component)
- `/dashboard/[id]` — Position detail (client component). Tick range displayed as USD price range using `1.0001^tick * 10^(d0-d1)`. Est. Daily/Monthly Fees are pool-APY × value projections, not position-specific.
- `/analytics` — Recharts visualizations of demo position data
- `/wallet` — Shows ETH + ERC-20 balances via Alchemy RPC

## Environment

Requires `NEXT_PUBLIC_ALCHEMY_KEY` in `.env.local` for RPC calls and wallet balance fetching.

---

## Project: DefiDesh (formerly LP Tracker)

- DeFi liquidity position tracking dashboard — rebranded to DefiDesh
- Deployed at lp-tracker-two.vercel.app
- GitHub: Robicon0/lp-tracker
- Tech: Next.js, TypeScript, Tailwind CSS, React Query

## Current Integrations (Working)

1. Aerodrome (Base) — Sugar V3 contract, real positions fetching ✅
2. Uniswap V3 (Ethereum, Arbitrum, Polygon, Optimism) — NonfungiblePositionManager ✅
3. Velodrome (Optimism) — Sugar contract with selector `0xedbd33bf` ✅
4. Raydium CLMM (Solana) — Helius RPC, program `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK` ✅
5. Orca Whirlpools (Solana) — Helius RPC, Token2022 NFTs ✅
6. Cetus CLMM (Sui) — Sui public RPC, position type `::position::Position` ✅
7. Bluefin (Sui) — Sui public RPC, Q64 fee math ✅
8. Momentum (Sui) — Sui public RPC, package `0x70285592...`, Q64 fee math ✅
9. HyperSwap V3 (HyperEVM) — public RPC `https://rpc.hyperliquid.xyz/evm`, NFT manager `0x6eda206207c09e5428f281761ddc0d300851fbc8` ✅
10. KittenSwap (HyperEVM) — same RPC, NFT manager `0xb9201e89f94a01ff13ad4caecf43a2e232513754` ✅
11. ProjectX / PRJX (HyperEVM) — same RPC, NFT manager `0xead19ae861c29bbb2101e834922b2feee69b9091` ✅
12. CoinGecko for prices, DefiLlama for APY data ✅
13. React Query context (`PositionsContext.tsx`) fetches all in parallel ✅

## Wallet

- Primary wallet: `0xD99a5c1d3F93F1a7cfA77025A8F1532a0cEF4F20`
- All 3 prior Aerodrome positions (WETH/USDC, WETH/USDC, USDC/cbBTC) are now closed (zero liquidity, zero value) and shown as 'Closed'
- Solana: GndRtybRYe3ShqES4RXpw9hq2MysJRLkjEf99M6PpogC — active SOL/USDC Orca position
- MetaMask for EVM chains

## Roadmap

- ~~Phase 2: Solana (Raydium/Orca) with Phantom wallet~~ ✅ Done
- ~~Phase 3: Sui (Cetus/Bluefin/Momentum) with Sui wallet~~ ✅ Done
- ~~Feature 1: Impermanent Loss Calculator~~ ✅ Done
- ~~Feature 2: Wallet Address Badges~~ ✅ Done
- Feature 3: New protocol integrations (Camelot, Trader Joe, SushiSwap, etc.) — **deferred** (no active positions)
- ~~Feature 4: PancakeSwap V3 (BNB Chain)~~ ✅ Done
- ~~Feature 5: Watch Wallet~~ ✅ Done
- Feature 6: Aptos — **deferred** (no active positions)
- ~~Feature 7: Current vs Invested Assets (Aerodrome)~~ ✅ Done
- ~~Feature 8: Activity History Table (Aerodrome)~~ ✅ Done
- ~~Feature 9: Actual APR from claimed fees (Aerodrome)~~ ✅ Done
- Remove demo data, show empty state when no wallet connected
- ~~DefiDesh rebrand + full dashboard redesign~~ ✅ Done

## Dev Workflow

- Two machines: Mac mini + MacBook, synced via VS Code Cloud Changes
- Push to GitHub → auto-deploys on Vercel
- Dev server: `cd ~/lp-tracker-fresh && npm run dev`
- Alchemy API key in `.env.local` and Vercel env vars

## Security Rules

CRITICAL: Wallets must ONLY show as connected when the user has actively unlocked and connected them. A locked wallet must NEVER auto-connect to the site. This applies to ALL chains — EVM, Solana, Sui, and any future chains. Always use explicit user consent tracking (not just checking if a public key exists) to determine connection state.

**Implementation**: `WalletAuthContext` (`app/contexts/WalletAuthContext.tsx`) stores `solanaAddress: string | null` — the actual address, set only after a user-initiated connect succeeds. Use the adapter (e.g. `useWallet()`) ONLY for mechanics: listing wallets, calling select/connect/disconnect. Never read `connected` or `publicKey` from the adapter for display — a locked Phantom wallet keeps those truthy via Wallet Standard silent reconnect. All components (Navbar, PositionsContext, Dashboard, Analytics, WalletPage) read `solanaAddress` from `WalletAuthContext`. Capture `publicKey` after connect via a `useRef` flag + `useEffect` to avoid stale closure issues in async handlers.

## Key Learnings

- Velodrome uses `positions()` with 3 args (no factory param), NOT `positionsByFactory`
- BigInt requires ES2020 target in `tsconfig.json`
- Aerodrome positions are staked in gauges, not held as NFTs directly
- DefiLlama `apyBase` (fee-only) with median prevents APY outliers
- Tick-to-price: `price = 1.0001^tick * 10^(decimals0 - decimals1)` gives token0 price in token1. If token1 is stable → show directly as USD. If token0 is stable → show `1/price`. All API routes now pass `token0Decimals`/`token1Decimals` in positions.
- Est. Daily Fees / Monthly Yield on detail page are APY-based projections (`value * apy / 100 / 365` and `/12`), not position-specific — labeled "(pool APY × value)"
- Closed positions: ALL API routes return zero-liquidity positions as `status: 'Closed'` — never filter them out. Sugar (Aerodrome/Velodrome), Uni V3, Raydium, Orca, Cetus, Bluefin, Momentum, HyperSwap all follow this rule. IMPORTANT: Positions that were fully closed on-chain (NFT burned on Solana, position object deleted on Sui, NFT burned on EVM) CANNOT be recovered from current chain state — they simply don't exist anymore. Only positions with 0 liquidity whose NFT/object still exists in the wallet will show as 'Closed'.
- Raydium: `getNftMints` queries both TOKEN_PROGRAM and TOKEN_PROGRAM_2022 (matching Orca) to ensure all NFT variants are captured.
- Solana closed position limitation: When a Solana LP position (Orca/Raydium) is fully closed, the NFT is BURNED and no longer exists on-chain. Cannot be recovered via `getTokenAccountsByOwner`. Only positions with 0 liquidity whose NFT was NOT burned show as 'Closed'. Dashboard shows an info note when Solana/Sui wallet is connected.
- Sui closed position limitation: When a Sui LP position (Cetus/Bluefin/Momentum) is fully closed, the position OBJECT IS DESTROYED on-chain. `suix_getOwnedObjects` only returns currently-owned objects. Destroyed objects cannot be recovered. Positions that exist with 0 liquidity (NFT unburned) still show as 'Closed'. Cetus/Bluefin/Momentum use cursor-based pagination (50/page, loops until `hasNextPage=false`) — pagination is NOT the issue for missing positions.
- Momentum (Sui): package `0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860`. Position fields: `pool_id`, `type_x`/`type_y` (TypeName structs → `.fields.name`), `tick_lower_index`/`tick_upper_index` (I32), `liquidity`, `fee_growth_inside_x_last`/`_y_last`, `owed_coin_x`/`owed_coin_y`. Pool fields: `sqrt_price` (Q64.64), `tick_index`, `fee_growth_global_x`/`_y`, `ticks` (Table). Tick fields: `fee_growth_outside_x`/`_y`. Uses Q64 scaling (>> 64n). Not on DefiLlama (APY=0).
- Solana token resolution: Orca + Raydium routes use Helius DAS `getAssetBatch` as fallback for any tokens not in the static KNOWN_TOKENS map (symbol, decimals, price)
- Dashboard position sort: always groups In Range → Out of Range → Closed (STATUS_ORDER primary), user sort key secondary
- Portfolio history P&L label: shows "since [date]" when actual data coverage < 50% of selected range duration; range buttons dim when no data exists in that window
- HyperEVM chain: ID 999, RPC `https://rpc.hyperliquid.xyz/evm`, native HYPE. HyperSwap V3 NFT manager `0x6eda206207c09e5428f281761ddc0d300851fbc8`, KittenSwap `0xb9201e89f94a01ff13ad4caecf43a2e232513754`, ProjectX/PRJX `0xead19ae861c29bbb2101e834922b2feee69b9091`. WHYPE `0xadcb2f358eae6492f61a5f87eb8893d09391d160`, USDC `0xb88339cb7199b77e23db6e890353e22632ba630f`. No Alchemy key needed for HyperEVM (use public RPC). DefiLlama projects: `hyperswap-v3`, `kittenswap`, `projectx`. All 3 queried in same `/api/hyperswap` route.
- HyperEVM V3 forks use `positions(uint256)` selector `0x99fbab88` (NOT standard Uniswap V3's `0x99fd0e82`). Verified across HyperSwap, KittenSwap, and ProjectX.
- HyperEVM int24 tick decoding: ABI encodes int24 sign-extended to 32 bytes (e.g. tick -244010 = `0xffff...fffc46d6`). Decode by reading last 3 bytes and checking >= 0x800000 to sign-extend to int24. Using the full 256-bit value with 0x1000000 subtraction gives wrong results.
- HyperEVM native HYPE is represented as `0x5555555555555555555555555555555555555555` in V3 pool token slots (not WHYPE which is `0xadcb2f...`).
- HyperEVM pending fees: `tokensOwed0/1` in `positions()` only holds settled fees. Pending fees require feeGrowthInside math: fetch pool via `factory()→getPool()`, then `slot0()`, `feeGrowthGlobal0/1X128()`, and `ticks(tickLower/Upper)`. Pool-level selectors are standard Uniswap V3 (no custom selectors needed for pool contracts): `factory()=0xc45a0155`, `getPool(addr,addr,uint24)=0x1698ee82`, `slot0()=0x3850c7bd`, `feeGrowthGlobal0X128()=0xf3058399`, `feeGrowthGlobal1X128()=0x46141319`, `ticks(int24)=0xf30dba93`. feeGrowthOutside is at word[2]/word[3] of the ticks() response. Pending = `liquidity * ((fgInside - checkpoint) & U256_MASK) >> 128`. Always use U256_MASK = (1n<<256n)-1n for wrapping arithmetic.
- PRJX factory: `0xff7b3e8c00e57ea31477c32a5b52a58eea47b072`. Hardcode known factory addresses in POSITION_MANAGERS to skip the factory() RPC call.
- DefiLlama DOES index ProjectX — project name is `"project-x"` (with hyphen, NOT `"projectx"`). Chain name for all HyperEVM protocols is `"Hyperliquid L1"` (NOT `"HyperEVM"`). DefiLlama HYPE/USDC APY is pool-wide (~50%); prjx.com shows position-specific concentrated APR (~129%) — this difference is expected. The `computePendingFees` silently returns {0n,0n} on any RPC failure — always add `console.error` logging at each failure point so Vercel function logs can diagnose issues.
- V3 pending fee integration checklist for new chains: (1) parse `feeGrowthInside0/1LastX128` from `positions()` words [8] and [9], (2) implement `computePendingFees` with factory lookup + pool state + tick data, (3) hardcode factory if known, (4) add console.error at each silent-return path, (5) total fees = tokensOwed + pending.
- HyperEVM amount calculation: MUST use actual `sqrtPriceX96` from `slot0()` (word 0 of slot0 response, uint160), NOT a midpoint estimate between ticks. Midpoint gives wildly wrong values (e.g. 5x too high). `sqrtPrice = Number(sqrtPriceX96) / 2^96`. Use `fetchPoolExtras` pattern that fetches slot0 + feeGrowth + ticks in one function to reuse both for amount calc and fee calc (no duplicate RPC calls). Range status = `currentTick >= tickLower && currentTick < tickUpper`.
- Aerodrome Slipstream (CL) on Base — on-chain activity scanning: NonfungiblePositionManager `0x827922686190790b37229fd06084350E74485b72` (verified via `factory()` = CL_FACTORY). Correct event topic0 hashes (computed with viem keccak256 — NEVER hardcode from memory): `IncreaseLiquidity=0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f`, `DecreaseLiquidity=0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4`, `Collect=0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01`. tokenId is indexed (topic1). Data layout for Increase/Decrease: word0=liquidity(uint128), word1=amount0, word2=amount1. Data layout for Collect: word0=recipient(address), word1=amount0Collected, word2=amount1Collected.
- eth_getLogs RPC limits: Alchemy free tier caps at 10 blocks per request — useless for history scans. Public Base RPC (mainnet.base.org) and DRPC cap at 10,000 blocks. Blast public RPC (`https://base-mainnet.public.blastapi.io`) supports ANY block range as long as result count < 10K — ideal for tokenId-filtered scans (a single position has ≤50 events). Use Blast for `eth_getLogs` in activity routes; use Alchemy for all other calls (eth_call, eth_getBlockByNumber, etc.).
- Phase 3 activity hook pattern: `usePositionActivity` accepts token0Address, token1Address, price0, price1 — forwards to `/api/aerodrome/activity` as query params (token0, token1, p0, p1). Hook must be called BEFORE any conditional early returns in the component (React hooks rules). Sort events chronologically to compute cumulativeFeeUSD, then reverse to newest-first for display.
- CoinGecko historical prices: `/coins/{id}/history?date=DD-MM-YYYY` returns `market_data.current_price.usd`. Cap at 30 most recent unique dates; older dates and fetch failures fall back to current price. Known Base token → CoinGecko ID map in activity route (WETH→ethereum, USDC→usd-coin, cbBTC→bitcoin, DAI→dai). Fetch both tokens in parallel per date.
- Actual APR formula: `(totalFeesUSD / positionValue) / (daysActive / 365) * 100`. `totalFeesUSD` = sum of `fee_claim` events using `usdAtTime` with current-price fallback. `daysActive` = `(nowTs - firstDepositTs) / 86400`. Guard: if daysActive < 1, show fees but omit APR. If no fee claims, show "No fees claimed yet" instead of 0%.
- `useWalletTokens` cleanup pattern: use a `fetchCompleted` local boolean, set to `true` just before the final `setData`. In the cleanup return, only reset `fetchedForRef.current = null` when `!fetchCompleted`. Reason: Solana/Sui wallet connect events can briefly set wagmi `address` to `undefined` and back, which fires the cleanup and re-queues a fetch (setting `isLoading: true` again). Keeping `fetchedForRef` set after a successful fetch prevents spurious refetches while still allowing StrictMode's immediate cleanup to retry (fetchCompleted=false at that point).
- `useWalletTokens` scope — EVM + Solana + Sui: The hook reads from all three wallet contexts (`useAccount` for EVM, `useWalletAuth` for Solana/Sui). Uses a composite `fetchKey = [evmAddr, solanaAddr, suiAddr].filter(Boolean).join("|")` to refetch whenever any wallet changes. All three chain scans run in parallel via `Promise.allSettled(scanTasks)`. EVM = 5 Alchemy chains. Solana = calls `/api/solana/balances` (Helius server-side, returns solBalance + SPL tokens). Sui = calls `/api/sui/balances` (public Sui RPC, returns suiBalance + coins). Lending/Borrowing = AAVE V3 aTokens/debtTokens on EVM only (detected by symbol prefix). Solana/Sui lending protocols are NOT yet implemented.
- Hydration fix (Refresh button): Do NOT use the `disabled` HTML attribute on this button — `isFetching` from React Query changes between SSR and client hydration, causing a persistent mismatch no matter how you gate it. Instead: remove `disabled` entirely, use `aria-disabled={isFetching}` + `onClick={() => { if (!isFetching) refetch(); }}` + `cursor: isFetching ? "not-allowed" : "pointer"`. This eliminates the attribute from the server-rendered HTML entirely.
- Suilend (Sui lending): Package `0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf`. Users own `ObligationOwnerCap<MAIN_POOL>` objects (NOT Obligation directly). Cap has `obligation_id` → fetch Obligation via `sui_getObject`. Obligation.deposits[] has `reserve_array_index` + `deposited_ctoken_amount` (u64). DO NOT USE `market_value` (stale!). Correct approach: fetch LendingMarket `0x84030d26...`, get all 45 reserves. Each reserve has `available_amount` (u64 base), `borrowed_amount` (Decimal: value/10^18 = base units), `unclaimed_spread_fees` (Decimal), `ctoken_supply` (u64), `cumulative_borrow_rate` (Decimal), `price` (Decimal: oracle price). exchange_rate = (available + borrowed_val/WAD - fees_val/WAD) / ctoken_supply (all BigInt). underlying = ctokens * exchange_rate / 10^decimals. For borrows: current = ob_borrow_val * reserve_cbr / ob_cbr / WAD / 10^decimals. Supply APR from on-chain: `config.fields.element.fields` has `interest_rate_utils` (array of utilization %) + `interest_rate_aprs` (bps, strings) + `spread_fee_bps`. Interpolate borrow APR at current utilization, then supply_apr = borrow_apr * utilization * (1 - spread_fee). Suilend NOT on DefiLlama. Use reserve `price` field as CoinGecko fallback (oracle price ≈ market price). `useLendingPositions` dep array MUST include `suiAddress` or Sui-only wallets never trigger fetch.
- AlphaFi / AlphaLend (Sui): Old pkg `0xd631cd66...`, new pkg `0x5209a18e...`. Query BOTH PositionCap types. Position is stored as a DYNAMIC FIELD in positions table (`0x9923cec7...`) keyed by `0x2::object::ID` — use `suix_getDynamicFieldObject(POSITIONS_TABLE, {type:"0x2::object::ID", value:position_id})`. Collaterals: `VecMap<u64,u64>` market_id→ctoken_amount. To get USD: fetch market from markets table (`0x2326d387...`) by market_id, get `xtoken_ratio` (Number/10^18) and `coin_type`. `underlying = ctoken_raw * xtoken_ratio / 10^decimals`. Vault receipts: `0x9bbd650b...::alphapool::Receipt`. LendingProtocol object: `0x01d9cf05...`.
- Jupiter Lend (Solana): API at `api.jup.ag/lend/v1/earn/positions?users={addr}` returns flat array. Key fields: `shares` (filter zeros), `underlyingAssets` (raw amount), `token.asset.price` (USD price string), `token.totalRate` (bps, e.g. 347 = 3.47% APY). No CoinGecko needed — price already in response.
- Dashboard Lending card: imports `useLendingPositions`, sums `totalLendingValue` (AAVE from useWalletTokens) + `externalLendingValue` (Dolomite+Jupiter+AlphaFi+Suilend). Both hooks share the same composite fetchKey pattern.
