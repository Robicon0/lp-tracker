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

## Project: LP Tracker

- DeFi liquidity position tracking dashboard
- Deployed at lp-tracker-two.vercel.app
- GitHub: Robicon0/lp-tracker
- Tech: Next.js, TypeScript, Tailwind CSS, React Query

## Current Integrations (Working)

1. Aerodrome (Base) — Sugar V3 contract, real positions fetching ✅
2. Uniswap V3 (Ethereum, Arbitrum, Polygon, Optimism) — NonfungiblePositionManager ✅
3. Velodrome (Optimism) — Sugar contract with selector `0xedbd33bf` ✅
4. CoinGecko for prices, DefiLlama for APY data ✅
5. React Query context (`PositionsContext.tsx`) fetches all 3 in parallel ✅

## Wallet

- Primary wallet: `0xD99a5c1d3F93F1a7cfA77025A8F1532a0cEF4F20`
- Currently has 3 Aerodrome positions on Base
- MetaMask for EVM chains

## Roadmap

- Phase 2: Solana (Raydium/Orca) with Phantom wallet
- Phase 3: Sui (Cetus/Bluefin/Momentum) with Sui wallet
- Remove demo data, show empty state when no wallet connected

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
