---
name: burned-nft-recovery
description: Use this skill when adding closed-position recovery for any EVM protocol where the position NFT is burned (transferred to the zero address) on close, making it invisible to standard balanceOf queries. Triggers include phrases like "burned NFT", "closed positions missing on [EVM protocol]", "balanceOf doesn't return closed positions", "ever-owned NFT IDs", "recover closed positions on Base/Arbitrum/Optimism", or any task to add closed-position support for a new EVM protocol. This skill encodes the pattern proven on Aerodrome (90faaf9), Uniswap V3 (7c60cce), and Velodrome (6601d38).
allowed-tools: Read, Bash, Grep, Glob
---

# Burned-NFT Recovery

This skill implements closed-position recovery for EVM protocols that
burn the position NFT on close. It encodes the pattern proven on three
protocols and provides a template for the fourth, fifth, and onward.

## When to use this skill

Invoke this skill when:

- Adding a new EVM protocol where users report missing closed positions
- Investigating low closed-position counts for an existing EVM protocol
- Building support for a Uniswap V3 fork on a new chain (most V3 forks
  burn NFTs on close)

Do not invoke this skill for:

- Non-EVM chains (Sui and Solana destroy position objects entirely; that
  is a different recovery problem — see Sprint 3 and Sprint 5)
- HyperEVM (no archival eth_call means the resolver cannot run; see
  pricing-invariants.md for the workaround)
- Protocols where positions are not represented as NFTs (lending positions,
  vault positions, AMM LP tokens without NFT wrapping)

## The problem this skill solves

Standard EVM NFT queries use `balanceOf(wallet)` to enumerate current
holdings. When a user closes a V3 position, many protocols burn the NFT
(transfer to the zero address) instead of keeping it with the user.
After the burn:

- `balanceOf(wallet)` no longer returns the NFT
- The position data still exists on-chain (positions(tokenId) returns
  the historical state)
- The user can no longer enumerate which token IDs they ever owned

Without recovery, closed positions disappear from DefiDesh after close.
Lifetime fee totals are wrong. Capital G/L is incomplete.

## The solution pattern

Build a list of *ever-owned* NFT IDs by querying historical Transfer
events instead of current balances. The pattern lives in
`app/lib/evmEverOwnedNftIds.ts`.

### Conceptual flow

1. Query Transfer events from the NFT contract where the wallet was
   either sender or receiver
2. Build the union set of all token IDs the wallet ever touched
3. For each token ID, call `positions(tokenId)` to get historical data
4. Compute fees and G/L from the historical data, even if the NFT no
   longer exists in the wallet

### Why this works

EVM event logs are permanent and archival on most chains. Even after the
NFT is burned, the Transfer events that created and destroyed it are
queryable forever. The position contract's `positions(tokenId)` view
typically remains callable even for burned token IDs (the storage slot
still exists; only the NFT-ownership mapping is cleared).

## Implementation checklist

When adding burned-NFT recovery for a new EVM protocol, follow this
sequence:

### Step 1: Confirm the protocol burns NFTs on close

Before implementing recovery, verify the protocol actually burns on close.
Some V3 forks do not — they keep the NFT with the user and just set
liquidity to zero, in which case standard `balanceOf` already works.

Test:

1. Identify a known closed position on the protocol (Osho's wallet or
   any test wallet)
2. Call `balanceOf(wallet)` — does the closed position's token ID
   appear in the returned list?
3. If yes → no recovery needed. Skip this skill.
4. If no → recovery is needed. Continue.

### Step 2: Identify the NFT contract address

Every EVM protocol has a specific NFT contract that issues position NFTs.
For example:

- Aerodrome: `0x...` (the position manager contract)
- Uniswap V3: `0xC36442b4a4522E871399CD717aBDD847Ab11FE88` (canonical)
- Velodrome: `0x...`

Find the protocol's NFT contract before continuing. It's usually called
"NonfungiblePositionManager" or similar in the contract source.

### Step 3: Use evmEverOwnedNftIds.ts

The helper at `app/lib/evmEverOwnedNftIds.ts` is the canonical
implementation. Do not rewrite it for each protocol. Pass the protocol's
NFT contract address, the wallet, and the chain. Get back the union set
of ever-owned token IDs.

### Step 4: Batched eth_getLogs with overflow guard

The helper uses batched `eth_getLogs` queries to retrieve Transfer events.
Two defensive measures are critical:

- **Batching**: split the block range into chunks to avoid hitting RPC
  request size limits
- **Overflow guard**: if a wallet has an unrealistic number of token IDs
  (the Uniswap V3 implementation uses $50M as the sanity threshold), log
  the anomaly and continue rather than crashing the route

Reason: some RPC providers cap eth_getLogs response size. Hitting the
cap silently returns truncated data. The overflow guard catches this.

### Step 5: Build closed positions from ever-owned IDs

After collecting the ever-owned set:

1. For each token ID, call `positions(tokenId)` on the NFT contract
2. Filter to positions where liquidity is currently zero (closed)
3. Reconstruct the position's historical state for fee calculation

If `positions(tokenId)` fails for a given ID (some token IDs may have
been transferred away, not burned), log via `[PRICE_LOG]` and continue.

### Step 6: Handle the empty-Sugar edge case (Aerodrome, Velodrome only)

For protocols using the Sugar contract pattern (Aerodrome, Velodrome),
there is a known edge case: if a wallet has zero open positions, the
Sugar contract's enumeration returns an empty array, which causes the
route's early-return path to skip `buildClosedPositions` entirely.

Fee recovery still works (fees are collected separately), but
closed-record display is gated. The fix is to allow `buildClosedPositions`
to run even when the Sugar enumeration is empty.

This edge case applies only to Aerodrome and Velodrome. Uniswap V3 does
not have this issue because it doesn't use the Sugar pattern.

This is currently a known limitation, pending fix in the sprint queue.

### Step 7: Preserve instrumentation

Every new resolution path must emit `[PRICE_LOG]` events per
`.claude/rules/instrumentation.md`:

- `price_lookup` events for each token priced during fee resolution
- `fee_claim_resolution` events for each fee claim valued
- `route_summary` event at end of route with resolved/total counts

If you add a new source (e.g., a new chain's recovery path), add the
source value to the enum in `priceLogger.ts`.

### Step 8: Verify against ground truth

After implementation, verify against Osho's manual claim records:

1. Identify a wallet with known closed positions on the new protocol
2. Compare DefiDesh's recovered closed-position count to the manual count
3. Compare DefiDesh's recovered fee totals to manual claim records
4. Acceptable margin: small differences in fee values due to price
   timing are okay; missing entire positions is not

If counts or values are off by significant margin, follow
`commit-protocol.md` Rule 3 (stop and report).

## Currently implemented

This pattern is live in production for:

- **Aerodrome (Base)**: commit `90faaf9`. Recovered 4 closed positions
  worth ~$743 in fees on initial deployment.
- **Uniswap V3 (Arbitrum, Ethereum, Optimism, Polygon, Base)**: commit
  `7c60cce`. Defensive batching with $50M overflow guard.
- **Velodrome (Optimism)**: commit `6601d38`. Uses the
  `VELODROME_FALLBACK` pool `0x9763...7c8b` (USDC/WETH, reversed token
  ordering) for cases where pool resolution fails.

## Known constraints

### HyperEVM is excluded

HyperEVM does not support archival `eth_call`. The Chainstack endpoint
returns `-32002 "Archive Debug Trace not available on plan"` and the
public RPC at `rpc.hyperliquid.xyz/evm` is non-archival for state.

Result: the burned-NFT recovery helper cannot run on HyperEVM. For
HyperSwap, KittenSwap, and ProjectX, claim-time pricing uses CoinGecko
historical (awaited for closed positions, fire-and-forget for open). See
`pricing-invariants.md` Rule 1.

### Empty-Sugar limitation (Aerodrome, Velodrome)

Documented in Step 6 above. Currently a known limitation, pending fix.

### Non-EVM chains are out of scope

This skill is EVM-only. Sui (Bluefin, Cetus, Momentum) and Solana (Orca,
Raydium) destroy position objects on close. They require event log
reconstruction (Sui) or transaction history parsing (Solana). Those are
separate sprints (Sprint 3 and Sprint 5).

## Anti-patterns

### Rewriting evmEverOwnedNftIds.ts per protocol

The helper is shared infrastructure. Adding protocol-specific logic
inside it is fine; forking it is not.

### Skipping Step 1 (confirming the burn behavior)

Some V3 forks keep NFTs on close. Implementing recovery for a protocol
that doesn't need it produces unnecessary RPC load and confusing logs.

### Forgetting the overflow guard

Without the $50M guard (or equivalent threshold), an RPC returning
truncated data will silently produce wrong counts. The guard catches
this case and surfaces it via `[PRICE_LOG]`.

### Treating fee recovery as the only goal

Recovery has two outputs: fees (for analytics totals) and closed-position
records (for the Closed tab in the dashboard). Both must work. The
empty-Sugar limitation breaks the second output even when the first
works.

## When to amend this skill

Amend this skill when:

- A new EVM protocol is added and the pattern needs a new entry under
  "Currently implemented"
- A new edge case is discovered (e.g., a protocol with a different
  enumeration quirk)
- The `evmEverOwnedNftIds.ts` helper is refactored in a way that changes
  the interface
- A new chain is added that supports archival eth_call and can use the
  helper

Do not amend based on a single fix. The pattern is stable.
