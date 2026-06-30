"use client";

import { useState, useEffect, useRef } from "react";
import type { AerodromePosition } from "../lib/aerodrome";
import type { ActivityEvent } from "./useAllPositionsActivity";

// Wallet-scope fee events. Captures fees from positions that no longer exist
// as on-chain objects / NFTs — i.e. fully closed Bluefin positions on Sui
// whose object has been destroyed. Per-position activity scans can't see
// these because there's no object to query anymore; a wallet-wide scan of
// protocol events recovers them.
//
// Strategy per chain:
//   Sui / Bluefin:  one call to /api/bluefin/activity?positionId=all per
//                   Sui wallet that has at least one Bluefin position; the
//                   route iterates the wallet's tx history and emits fee +
//                   reward events across ALL Bluefin positions ever owned.
//
// The output is a flat list of ActivityEvent tagged with protocol + chain,
// intended to be merged with per-position events via dedupe-by-txHash so
// open-position events are not double-counted.

export interface TaggedFeeEvent {
  event: ActivityEvent;
  protocol: string;
  chain: string;
}

interface RawActivityResponse {
  events?: ActivityEvent[];
}

interface SuiPoolContext {
  account: string;
  coinTypeA: string;
  coinTypeB: string;
  decimalsA: number;
  decimalsB: number;
  priceA: number;
  priceB: number;
}

// Bluefin fallback context — Bluefin pools are conventionally SUI(A)/USDC(B).
// Used for Sui wallets with no open Bluefin position, as (a) the trigger that
// fires the wallet-scope scan and (b) the reward-path / per-position context.
// Sprint TOKEN-RESOLUTION: fee-claim USD valuation NO LONGER depends on these
// coin types — the Bluefin activity route resolves each fee claim's REAL pool
// (and its coin types) on-chain per event. This `coinTypeB` previously carried a
// CORRUPTED USDC address (`…50a4ae…`, a fat-fingered Wormhole USDC) that matched
// no stablecoin and was unpriceable on DeFiLlama, so every closed-position fee
// claim's USDC side priced to null and the whole claim was dropped from Fee
// Income (~$3,847 missing across Osho's two wallets). Corrected to native Circle
// USDC — the type the real Bluefin SUI/USDC pool uses (and a member of the
// route's STABLECOINS set) — so it's also correct as a last-resort context.
const BLUEFIN_FALLBACK = {
  coinTypeA: "0x2::sui::SUI",
  coinTypeB: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  decimalsA: 9,
  decimalsB: 6,
  priceB: 1,
} as const;

// Cetus fallback context — Cetus's canonical USDC/SUI pool is USDC(A,6) /
// SUI(B,9), the REVERSE of Bluefin's ordering. Wallets whose Cetus positions
// are all closed have no open position to read the real ordering from, so
// without this distinct fallback the wallet-scope scan would price USDC
// amounts as SUI (and vice versa) — inflating reported fees by orders of
// magnitude when token decimals + price both flip together (e.g. $10 →
// $10,000 from a single fee_claim where amount_a was actually 10·10^6 USDC
// scaled against decimalsA=9). `priceB` (SUI) is injected at call site.
//
// Wallets in `cetusByWallet` (built from open Cetus positions in `positions`)
// take precedence over this fallback — the real per-position context is
// always preferred when available, mirroring how Bluefin per-wallet contexts
// are built.
const CETUS_FALLBACK = {
  coinTypeA: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  coinTypeB: "0x2::sui::SUI",
  decimalsA: 6,
  decimalsB: 9,
  priceA: 1,
} as const;

// Momentum (Sprint MOMENTUM) fallback context. Momentum's canonical pool is
// SUI(x=A,9) / USDC(y=B,6) — the SAME ordering as Bluefin, the REVERSE of Cetus
// (verified on-chain Phase A: Pool<0x2::sui::SUI, 0xdba34672…::usdc::USDC>). The
// Momentum dashboard route does not expose coinTypeA/coinTypeB on its positions,
// so unlike Cetus there is no per-open-position context to prefer — every Sui
// wallet's Momentum fee history is scanned with this fixed fallback (which is
// what recovers the closed positions' FeeCollectedEvents). `priceA` (SUI) is
// injected at call site from the live SUI spot; USDC anchors at $1.
const MOMENTUM_FALLBACK = {
  coinTypeA: "0x2::sui::SUI",
  coinTypeB: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  decimalsA: 9,
  decimalsB: 6,
  priceB: 1,
} as const;

// Aerodrome (Base) wallet-scope context — EVM analog of the Sui contexts above.
// Aerodrome Slipstream BURNS the position NFT on full close, so Sugar (position
// discovery) can't return closed positions; a positionId=all scan of the
// wallet's ever-owned tokenIds recovers their Collect (fee) events.
interface EvmPoolContext {
  account: string;
  token0: string;
  token1: string;
  decimals0: number;
  decimals1: number;
  pool: string;
  price0: number;
  price1: number;
}
// Fallback for wallets whose Aerodrome positions are all closed (no open
// position to read real token/pool ordering from): Base WETH/USDC CL pool.
// price0 (WETH) is left 0 — the activity route recovers it via CoinGecko
// historical (claim-time) + current spot, and USDC anchors at $1.
const AERODROME_FALLBACK = {
  token0: "0x4200000000000000000000000000000000000006",
  token1: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  decimals0: 18,
  decimals1: 6,
  pool: "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59",
  price0: 0,
  price1: 1,
} as const;

// Velodrome (Optimism) wallet-scope fallback — same role as AERODROME_FALLBACK
// but for the original Slipstream deployment on Optimism. The canonical
// Velodrome CL WETH/USDC pool is USDC(token0,6) / WETH(token1,18) — the REVERSE
// of Aerodrome's Base ordering, because USDC (0x0b2c…) sorts before WETH
// (0x4200…) on Optimism (verified on-chain via the CL factory). Pool/decimals/
// price ordering match that real pool so the activity route's sqrtPriceX96
// resolver anchors correctly. price1 (WETH) is left 0 — the activity route
// recovers it via CoinGecko historical (claim-time) + current spot; USDC
// anchors at $1.
const VELODROME_FALLBACK = {
  token0: "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
  token1: "0x4200000000000000000000000000000000000006",
  decimals0: 6,
  decimals1: 18,
  pool: "0x9763639de2eed0ef6bc4dd3a2514526060047c8b",
  price0: 1,
  price1: 0,
} as const;

// Uniswap V3 (multi-chain) wallet-scope context. Keyed by wallet+chain — the
// chain key comes from the position id (uni3-{chain}-{tokenId}). Display name
// is used as the event `chain` tag so wallet-scope events group with the
// per-position ones in the analytics fee breakdown.
interface UniV3Context {
  account: string;
  chain: string;        // ethereum | arbitrum | polygon | optimism | bnb
  token0: string;
  token1: string;
  decimals0: number;
  decimals1: number;
  price0: number;
  price1: number;
}
const UNI_CHAIN_DISPLAY: Record<string, string> = {
  ethereum: "Ethereum",
  arbitrum: "Arbitrum",
  polygon: "Polygon",
  optimism: "Optimism",
  bnb: "BNB Chain",
};

export function useWalletLevelFees(
  positions: AerodromePosition[],
  // Sui wallet addresses (connected + watched) to ALWAYS scan for Bluefin
  // fee history, even when no open Bluefin position exists for them. Without
  // this, a wallet whose Bluefin positions are all closed never gets its
  // lifetime fees fetched.
  suiWalletAddresses?: string[],
  // Live SUI spot price (USD) — used as priceA for the closed-wallet fallback
  // context so SUI-denominated fees are valued correctly instead of $0.
  suiPrice?: number,
): { events: TaggedFeeEvent[]; isLoading: boolean } {
  const [events, setEvents] = useState<TaggedFeeEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const fetchedKeyRef = useRef<string>("");

  useEffect(() => {
    // Group Bluefin positions by wallet. Pick the highest-value position per
    // wallet as the "representative" — its coin types / prices are used as
    // the USD fallback for any fee events from that wallet (fee events from
    // other Bluefin pools in the same wallet will get approximate USD, but
    // that's strictly better than dropping them).
    const bluefinByWallet = new Map<string, SuiPoolContext>();
    for (const p of positions) {
      if (p.protocol !== "Bluefin") continue;
      if (!p.walletAddress || !p.coinTypeA || !p.coinTypeB) continue;
      const existing = bluefinByWallet.get(p.walletAddress);
      if (!existing || p.value > 0) {
        // Always prefer a position with non-zero value as representative.
        if (!existing || p.value > 0) {
          bluefinByWallet.set(p.walletAddress, {
            account: p.walletAddress,
            coinTypeA: p.coinTypeA,
            coinTypeB: p.coinTypeB,
            decimalsA: p.token0Decimals ?? 9,
            decimalsB: p.token1Decimals ?? 6,
            priceA: p.price0 ?? 0,
            priceB: p.price1 ?? 0,
          });
        }
      }
    }

    // Cetus per-wallet context, derived from OPEN Cetus positions (now that
    // the Cetus route returns coinTypeA/coinTypeB on every position). This
    // replaces the previous always-SUI_FALLBACK behaviour that mis-priced
    // USDC/SUI fees by orders of magnitude when the actual pool ordering was
    // USDC(A)/SUI(B). Keyed by LOWERCASE wallet address so the loop below
    // can look up case-insensitively against suiWallets's preserved-casing
    // values.
    const cetusByWalletLower = new Map<string, SuiPoolContext>();
    for (const p of positions) {
      if (p.protocol !== "Cetus") continue;
      if (!p.walletAddress || !p.coinTypeA || !p.coinTypeB) continue;
      const lower = p.walletAddress.toLowerCase();
      const existing = cetusByWalletLower.get(lower);
      if (!existing || p.value > 0) {
        cetusByWalletLower.set(lower, {
          account: p.walletAddress,
          coinTypeA: p.coinTypeA,
          coinTypeB: p.coinTypeB,
          decimalsA: p.token0Decimals ?? 6,
          decimalsB: p.token1Decimals ?? 9,
          priceA: p.price0 ?? 0,
          priceB: p.price1 ?? 0,
        });
      }
    }

    // For any Sui wallet address NOT already covered by an open Bluefin
    // position, add a fallback context so its (closed-position) fee history
    // is still fetched. Dedupe case-insensitively against the open-position
    // wallets so we never double-fetch the same wallet.
    const coveredLower = new Set([...bluefinByWallet.keys()].map((k) => k.toLowerCase()));
    for (const addr of suiWalletAddresses ?? []) {
      if (!addr || coveredLower.has(addr.toLowerCase())) continue;
      coveredLower.add(addr.toLowerCase());
      bluefinByWallet.set(addr, { account: addr, ...BLUEFIN_FALLBACK, priceA: suiPrice && suiPrice > 0 ? suiPrice : 0 });
    }

    // Cetus wallet-scope fee + reward scans — same model as Bluefin above.
    // Cetus position objects don't expose coinTypeA / coinTypeB, so we always
    // use the SUI_FALLBACK context (priceA = live SUI, priceB = 1). The
    // analytics Fee Income memo dedupes by (protocol, txHash, amount0, amount1)
    // and pushes per-position events BEFORE wallet-level ones, so OPEN
    // positions keep their accurate per-position decimals and the wallet-scope
    // pass only adds net-new fees from fully-closed positions.
    //
    // Collect every unique Sui wallet from three sources so the scans fire
    // even when ALL of a protocol's positions are closed (and thus might not
    // appear as open positions in `positions`):
    //   1. bluefinByWallet.keys()  — wallets with Bluefin positions
    //   2. positions where chain === "Sui"  — covers Cetus / Momentum / closed
    //   3. suiWalletAddresses passed in  — connected + watched Sui wallets
    const suiWallets = new Map<string, string>(); // lowercase → original casing
    const addSui = (a?: string) => { if (a) suiWallets.set(a.toLowerCase(), a); };
    for (const a of bluefinByWallet.keys()) addSui(a);
    for (const p of positions) if (p.chain === "Sui") addSui(p.walletAddress);
    for (const a of suiWalletAddresses ?? []) addSui(a);

    const suiPriceA = suiPrice && suiPrice > 0 ? suiPrice : 0;

    // Compute the dedup key BEFORE creating any fetch() promises so we never
    // fire HTTP requests when neither the wallet set, the SUI price, nor any
    // wallet's Cetus pool ordering has changed since the last successful
    // fetch. Previously the key check happened AFTER fetch() calls were
    // already issued, causing redundant network traffic on every dependency
    // re-evaluation. Cetus context signature uses only coinTypeA/B (not
    // prices) so per-minute price refreshes don't trigger expensive
    // wallet-scope tx-history rescans — events cached from a slightly older
    // price are acceptable for lifetime fee totals.
    // Aerodrome (Base) wallet-scope: group by EVM wallet, representative context
    // from the highest-value position (prefer open), WETH/USDC fallback for
    // all-closed wallets. Flows into the analytics feeIncome merge tagged
    // protocol="Aerodrome" and is deduped by (protocol, txHash, amount0, amount1)
    // — so the open position's claims (also seen per-position) aren't double-counted.
    const aerodromeByWallet = new Map<string, EvmPoolContext>();
    for (const p of positions) {
      if (p.protocol !== "Aerodrome") continue;
      if (!p.walletAddress) continue;
      const lower = p.walletAddress.toLowerCase();
      const existing = aerodromeByWallet.get(lower);
      if (!existing || (p.value ?? 0) > 0) {
        aerodromeByWallet.set(lower, {
          account: p.walletAddress,
          token0: p.token0Address ?? AERODROME_FALLBACK.token0,
          token1: p.token1Address ?? AERODROME_FALLBACK.token1,
          decimals0: p.token0Decimals ?? AERODROME_FALLBACK.decimals0,
          decimals1: p.token1Decimals ?? AERODROME_FALLBACK.decimals1,
          pool: p.poolAddress ?? AERODROME_FALLBACK.pool,
          price0: p.price0 ?? 0,
          price1: p.price1 ?? 0,
        });
      }
    }

    // Velodrome (Optimism) wallet-scope — direct analog of the Aerodrome branch
    // above (Velodrome is the original Slipstream; Aerodrome is its Base fork,
    // identical NFT-burns-on-close behaviour). Representative context from the
    // highest-value position (prefer open), USDC/WETH fallback for all-closed
    // wallets. Tagged protocol="Velodrome" and deduped by
    // (protocol, txHash, amount0, amount1) against per-position open events.
    const velodromeByWallet = new Map<string, EvmPoolContext>();
    for (const p of positions) {
      if (p.protocol !== "Velodrome") continue;
      if (!p.walletAddress) continue;
      const lower = p.walletAddress.toLowerCase();
      const existing = velodromeByWallet.get(lower);
      if (!existing || (p.value ?? 0) > 0) {
        velodromeByWallet.set(lower, {
          account: p.walletAddress,
          token0: p.token0Address ?? VELODROME_FALLBACK.token0,
          token1: p.token1Address ?? VELODROME_FALLBACK.token1,
          decimals0: p.token0Decimals ?? VELODROME_FALLBACK.decimals0,
          decimals1: p.token1Decimals ?? VELODROME_FALLBACK.decimals1,
          pool: p.poolAddress ?? VELODROME_FALLBACK.pool,
          price0: p.price0 ?? 0,
          price1: p.price1 ?? 0,
        });
      }
    }

    // Uniswap V3 (multi-chain) wallet-scope: group by (wallet, chain) using the
    // chain key embedded in the position id; representative context from the
    // highest-value position on that wallet+chain. Recovers fees from burned
    // NFTs the position route can't return; deduped against per-position by
    // (protocol, txHash, amount0, amount1).
    const uniV3ByWalletChain = new Map<string, UniV3Context>();
    for (const p of positions) {
      if (p.protocol !== "Uniswap V3") continue;
      if (!p.walletAddress) continue;
      const m = p.id.match(/^uni3-([a-z]+)-/);
      const chainKey = m?.[1];
      if (!chainKey) continue;
      const key = `${p.walletAddress.toLowerCase()}|${chainKey}`;
      const existing = uniV3ByWalletChain.get(key);
      if (!existing || (p.value ?? 0) > 0) {
        uniV3ByWalletChain.set(key, {
          account: p.walletAddress,
          chain: chainKey,
          token0: p.token0Address ?? "",
          token1: p.token1Address ?? "",
          decimals0: p.token0Decimals ?? 18,
          decimals1: p.token1Decimals ?? 18,
          price0: p.price0 ?? 0,
          price1: p.price1 ?? 0,
        });
      }
    }

    const allWalletKeys = [...new Set([...bluefinByWallet.keys(), ...suiWallets.keys()])].sort();
    if (allWalletKeys.length === 0 && aerodromeByWallet.size === 0 && velodromeByWallet.size === 0 && uniV3ByWalletChain.size === 0) {
      setEvents([]);
      setIsLoading(false);
      return;
    }
    const cetusSig = [...cetusByWalletLower.entries()]
      .map(([w, c]) => `${w}:${c.coinTypeA}:${c.coinTypeB}`)
      .sort()
      .join(",");
    // Aerodrome signature: wallet + token/pool ordering only (not prices) so
    // per-minute price refreshes don't trigger a fresh tx-history rescan.
    const aeroSig = [...aerodromeByWallet.values()]
      .map((c) => `${c.account.toLowerCase()}:${c.token0}:${c.token1}:${c.pool}`)
      .sort()
      .join(",");
    // Velodrome signature: wallet + token/pool ordering only (not prices) so
    // per-minute price refreshes don't trigger a fresh tx-history rescan.
    const veloSig = [...velodromeByWallet.values()]
      .map((c) => `${c.account.toLowerCase()}:${c.token0}:${c.token1}:${c.pool}`)
      .sort()
      .join(",");
    const uniSig = [...uniV3ByWalletChain.values()]
      .map((c) => `${c.account.toLowerCase()}:${c.chain}:${c.token0}:${c.token1}`)
      .sort()
      .join(",");
    const key = allWalletKeys.join("|") + `::sui${suiPrice ?? 0}` + `::cetus[${cetusSig}]` + `::aero[${aeroSig}]` + `::velo[${veloSig}]` + `::uni[${uniSig}]`;
    if (key === fetchedKeyRef.current) return;
    fetchedKeyRef.current = key;

    // Build fetches only after confirming the key changed.
    const fetches: Array<Promise<TaggedFeeEvent[]>> = [];

    for (const ctx of bluefinByWallet.values()) {
      const url =
        `/api/bluefin/activity?positionId=all` +
        `&account=${encodeURIComponent(ctx.account)}` +
        `&coinTypeA=${encodeURIComponent(ctx.coinTypeA)}` +
        `&coinTypeB=${encodeURIComponent(ctx.coinTypeB)}` +
        `&decimalsA=${ctx.decimalsA}&decimalsB=${ctx.decimalsB}` +
        `&priceA=${ctx.priceA}&priceB=${ctx.priceB}`;
      fetches.push(
        fetch(url)
          .then((r) => (r.ok ? (r.json() as Promise<RawActivityResponse>) : { events: [] }))
          .then((j) =>
            (j.events ?? []).map((e) => ({ event: e, protocol: "Bluefin", chain: "Sui" })),
          )
          .catch((err) => {
            console.error("[wallet-fees bluefin] fetch failed:", err);
            return [];
          }),
      );
    }

    for (const acct of suiWallets.values()) {
      // Prefer the real per-wallet Cetus context (from an open position);
      // fall back to USDC(A)/SUI(B) ordering only when no open Cetus
      // position exists for this wallet. The fallback's priceB picks up the
      // live SUI spot so the SUI leg of any fee_claim is valued correctly.
      const realCtx = cetusByWalletLower.get(acct.toLowerCase());
      const ctx: SuiPoolContext = realCtx ?? {
        account: acct,
        ...CETUS_FALLBACK,
        priceB: suiPriceA,
      };
      const cetusUrl =
        `/api/cetus/activity?positionId=all` +
        `&account=${encodeURIComponent(ctx.account)}` +
        `&coinTypeA=${encodeURIComponent(ctx.coinTypeA)}` +
        `&coinTypeB=${encodeURIComponent(ctx.coinTypeB)}` +
        `&decimalsA=${ctx.decimalsA}&decimalsB=${ctx.decimalsB}` +
        `&priceA=${ctx.priceA}&priceB=${ctx.priceB}`;
      fetches.push(
        fetch(cetusUrl)
          .then((r) => (r.ok ? (r.json() as Promise<RawActivityResponse>) : { events: [] }))
          .then((j) =>
            (j.events ?? []).map((e) => ({ event: e, protocol: "Cetus", chain: "Sui" })),
          )
          .catch((err) => {
            console.error("[wallet-fees cetus] fetch failed:", err);
            return [];
          }),
      );

      // Momentum wallet-scope fee + reward scan — same model as Cetus/Bluefin.
      // Momentum positions don't expose coinTypeA/coinTypeB, so the fixed
      // SUI(A)/USDC(B) fallback is always used (priceA = live SUI). Recovers fee
      // (and historical-only reward) claims from fully-closed Momentum positions.
      // Tagged protocol="Momentum"; deduped by (protocol, txHash, amount0,
      // amount1) against any per-position open-position events.
      const momentumCtx: SuiPoolContext = {
        account: acct,
        ...MOMENTUM_FALLBACK,
        priceA: suiPriceA,
      };
      const momentumUrl =
        `/api/momentum/activity?positionId=all` +
        `&account=${encodeURIComponent(momentumCtx.account)}` +
        `&coinTypeA=${encodeURIComponent(momentumCtx.coinTypeA)}` +
        `&coinTypeB=${encodeURIComponent(momentumCtx.coinTypeB)}` +
        `&decimalsA=${momentumCtx.decimalsA}&decimalsB=${momentumCtx.decimalsB}` +
        `&priceA=${momentumCtx.priceA}&priceB=${momentumCtx.priceB}`;
      fetches.push(
        fetch(momentumUrl)
          .then((r) => (r.ok ? (r.json() as Promise<RawActivityResponse>) : { events: [] }))
          .then((j) =>
            (j.events ?? []).map((e) => ({ event: e, protocol: "Momentum", chain: "Sui" })),
          )
          .catch((err) => {
            console.error("[wallet-fees momentum] fetch failed:", err);
            return [];
          }),
      );
    }

    // Aerodrome (Base) wallet-scope fee scan — recovers Collect events from
    // burned-NFT positions Sugar can't return. Same merge+dedupe path as the
    // Sui scans above.
    for (const ctx of aerodromeByWallet.values()) {
      const aeroUrl =
        `/api/aerodrome/activity?positionId=all` +
        `&account=${encodeURIComponent(ctx.account)}` +
        `&token0=${encodeURIComponent(ctx.token0)}` +
        `&token1=${encodeURIComponent(ctx.token1)}` +
        `&t0d=${ctx.decimals0}&t1d=${ctx.decimals1}` +
        `&pool=${encodeURIComponent(ctx.pool)}` +
        `&p0=${ctx.price0}&p1=${ctx.price1}`;
      fetches.push(
        fetch(aeroUrl)
          .then((r) => (r.ok ? (r.json() as Promise<RawActivityResponse>) : { events: [] }))
          .then((j) =>
            (j.events ?? []).map((e) => ({ event: e, protocol: "Aerodrome", chain: "Base" })),
          )
          .catch((err) => {
            console.error("[wallet-fees aerodrome] fetch failed:", err);
            return [];
          }),
      );
    }

    // Velodrome (Optimism) wallet-scope fee scan — recovers Collect events from
    // burned-NFT positions Sugar can't return. Same merge+dedupe path as the
    // Aerodrome scan above (Velodrome is the original Slipstream architecture).
    for (const ctx of velodromeByWallet.values()) {
      const veloUrl =
        `/api/velodrome/activity?positionId=all` +
        `&account=${encodeURIComponent(ctx.account)}` +
        `&token0=${encodeURIComponent(ctx.token0)}` +
        `&token1=${encodeURIComponent(ctx.token1)}` +
        `&t0d=${ctx.decimals0}&t1d=${ctx.decimals1}` +
        `&pool=${encodeURIComponent(ctx.pool)}` +
        `&p0=${ctx.price0}&p1=${ctx.price1}`;
      fetches.push(
        fetch(veloUrl)
          .then((r) => (r.ok ? (r.json() as Promise<RawActivityResponse>) : { events: [] }))
          .then((j) =>
            (j.events ?? []).map((e) => ({ event: e, protocol: "Velodrome", chain: "Optimism" })),
          )
          .catch((err) => {
            console.error("[wallet-fees velodrome] fetch failed:", err);
            return [];
          }),
      );
    }

    // Uniswap V3 (multi-chain) wallet-scope fee scan — recovers Collect events
    // from burned NFTs the position route can't return. One call per (wallet,
    // chain). Same merge+dedupe path as the scans above.
    for (const ctx of uniV3ByWalletChain.values()) {
      const uniUrl =
        `/api/uniswap/activity?tokenId=all` +
        `&account=${encodeURIComponent(ctx.account)}` +
        `&chain=${encodeURIComponent(ctx.chain)}` +
        `&token0=${encodeURIComponent(ctx.token0)}` +
        `&token1=${encodeURIComponent(ctx.token1)}` +
        `&t0d=${ctx.decimals0}&t1d=${ctx.decimals1}` +
        `&p0=${ctx.price0}&p1=${ctx.price1}`;
      const displayChain = UNI_CHAIN_DISPLAY[ctx.chain] ?? ctx.chain;
      fetches.push(
        fetch(uniUrl)
          .then((r) => (r.ok ? (r.json() as Promise<RawActivityResponse>) : { events: [] }))
          .then((j) =>
            (j.events ?? [])
              // Drop decimals-mismatch overflow artifacts: a wallet with MULTIPLE
              // distinct pairs on one chain has its non-representative pair scaled
              // by the single representative context, which for a decimals
              // mismatch yields billions. Real fee claims are far under $50M, so
              // this strips only the garbage and never a legitimate claim.
              .filter((e) => Math.abs(e.usdAtTime ?? 0) <= 50_000_000)
              .map((e) => ({ event: e, protocol: "Uniswap V3", chain: displayChain })),
          )
          .catch((err) => {
            console.error("[wallet-fees uniswap] fetch failed:", err);
            return [];
          }),
      );
    }

    let cancelled = false;
    setIsLoading(true);
    Promise.all(fetches).then((groups) => {
      if (cancelled) return;
      setEvents(groups.flat());
      setIsLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [positions, suiWalletAddresses, suiPrice]);

  return { events, isLoading };
}
