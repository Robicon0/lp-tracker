// vfat / Sickle — per-chain SickleFactory configuration.
//
// WHY THIS EXISTS
// vfat deploys a "Sickle": a per-user smart-contract wallet (one per user per
// chain) that HOLDS the user's AMM position NFTs. The user's EOA owns nothing,
// so DefiDesh's EVM readers — which scan the EOA — return zero for a vfat user.
// This is the same wrapper-invisibility class as DefiTuna on Solana, now on EVM.
// Resolving owner -> Sickle is the whole discovery problem; once resolved, the
// positions inside are ordinary Aerodrome / Velodrome / Uniswap-V3 NFTs that the
// existing routes already decode. No new fee math, tick decoder, or price path.
//
// THE FACTORY ADDRESS IS NOT UNIFORM ACROSS CHAINS. That is why this is a config
// MAP and not a branch: architecture Rule 2 forbids per-chain logic in client
// code but explicitly allows per-chain PARAMETERS in config.
//
// Source of truth: DefiLlama's production `projects/vfat/config.js` (the same
// file that computes vfat's ~$30.9M TVL). Every address below was additionally
// verified live via eth_call before being committed — see the Phase A report,
// `reports/wrapper-protocol-landscape-survey-report.md`.
//
// SCOPE: vfat runs on ~18 chains. These four are the ones DefiDesh both has an
// RPC for and already decodes the underlying AMMs on. Adding a chain here is a
// one-line change and needs no other code.

export interface VfatChainConfig {
  /** DefiDesh's internal chain label. */
  chain: string;
  /** vfat SickleFactory on this chain. Deliberately NOT uniform across chains. */
  factory: string;
  /** Alchemy host segment; the key is interpolated at call time, never stored. */
  alchemyHost: string;
}

export const VFAT_CHAINS: VfatChainConfig[] = [
  // Base is vfat's heartland — the majority of live Sickles and TVL.
  { chain: 'base',     factory: '0x71D234A3e1dfC161cc1d081E6496e76627baAc31', alchemyHost: 'base-mainnet' },
  { chain: 'optimism', factory: '0xB4C31b0f0B76b351395D4aCC94A54dD4e6fbA1E8', alchemyHost: 'opt-mainnet' },
  { chain: 'arbitrum', factory: '0x53d9780DbD3831E3A797Fd215be4131636cD5FDf', alchemyHost: 'arb-mainnet' },
  { chain: 'ethereum', factory: '0x9D70B9E5ac2862C405D64A0193b4A4757Aab7F95', alchemyHost: 'eth-mainnet' },
];

/**
 * `sickles(address owner) -> address` selector.
 *
 * Returns the DEPLOYED Sickle, or the zero address when the owner has never
 * opened a vfat position on that chain — so ONE call answers both "what is the
 * address" and "does it exist". That is why this is the discovery primary.
 *
 * The factory also exposes `predict(address) -> address` (0x901b96e7), which
 * returns the deterministic CREATE2 address whether or not it is deployed, and
 * Phase A proved the address can be re-derived entirely offline (3/3 match, zero
 * RPC). That is a FUTURE OPTIMIZATION for cutting RPC calls — deliberately NOT
 * the MVP path, because it cannot by itself tell us whether a Sickle exists.
 */
export const SICKLES_SELECTOR = '0x967e4da8';

/** Build the RPC URL for a configured chain. Returns null when no key is set. */
export function vfatRpcUrl(cfg: VfatChainConfig): string | null {
  const key = process.env.NEXT_PUBLIC_ALCHEMY_KEY;
  if (!key) return null;
  return `https://${cfg.alchemyHost}.g.alchemy.com/v2/${key}`;
}

/** ABI-encode `sickles(owner)`: 4-byte selector + left-padded 32-byte address. */
export function encodeSicklesCall(owner: string): string {
  return SICKLES_SELECTOR + owner.replace(/^0x/, '').toLowerCase().padStart(64, '0');
}

/**
 * Decode a 32-byte address return value. Returns null for the zero address —
 * which is the factory's "this owner has no Sickle here" answer, not an error.
 */
export function decodeAddressResult(hex: unknown): string | null {
  if (typeof hex !== 'string' || hex.length < 66) return null;
  const addr = '0x' + hex.slice(-40);
  if (/^0x0{40}$/i.test(addr)) return null;
  return addr.toLowerCase();
}
