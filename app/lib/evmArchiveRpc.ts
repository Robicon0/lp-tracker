// Per-chain "archive RPC" — the ONE place the EVM history endpoints are named.
//
// These endpoints serve wide-range `eth_getLogs` and historical `eth_call`.
// They used to be twelve hardcoded public Tenderly gateway URLs spread over six
// route files, with a single env override on one of them. When the public Base
// gateway capped `eth_getLogs` at 1,000 blocks (measured 2026-10-07) there was
// no way to point Base at another provider without a code change.
//
// Each chain reads its own env var through `rpcUrlFromEnv` (a malformed value
// behaves like unset) and falls back to the public gateway. The var has to be
// per chain because provider URLs are per network.
//
//   EVM_ARCHIVE_RPC_BASE       (alias: TENDERLY_NODE_RPC — the original Base var)
//   EVM_ARCHIVE_RPC_ETHEREUM
//   EVM_ARCHIVE_RPC_ARBITRUM
//   EVM_ARCHIVE_RPC_POLYGON
//   EVM_ARCHIVE_RPC_OPTIMISM
//
// Values are secrets (keyed URLs): never log what this returns.

import { rpcUrlFromEnv } from './rpcEnv';

export type ArchiveChain = 'base' | 'ethereum' | 'arbitrum' | 'polygon' | 'optimism';

const PUBLIC_GATEWAY: Record<ArchiveChain, string> = {
  base: 'https://base.gateway.tenderly.co',
  ethereum: 'https://mainnet.gateway.tenderly.co',
  arbitrum: 'https://arbitrum.gateway.tenderly.co',
  polygon: 'https://polygon.gateway.tenderly.co',
  optimism: 'https://optimism.gateway.tenderly.co',
};

const ENV_VARS: Record<ArchiveChain, string[]> = {
  base: ['EVM_ARCHIVE_RPC_BASE', 'TENDERLY_NODE_RPC'],
  ethereum: ['EVM_ARCHIVE_RPC_ETHEREUM'],
  arbitrum: ['EVM_ARCHIVE_RPC_ARBITRUM'],
  polygon: ['EVM_ARCHIVE_RPC_POLYGON'],
  optimism: ['EVM_ARCHIVE_RPC_OPTIMISM'],
};

export function archiveRpcUrl(chain: ArchiveChain): string {
  for (const name of ENV_VARS[chain]) {
    const url = rpcUrlFromEnv(name);
    if (url) return url;
  }
  return PUBLIC_GATEWAY[chain];
}

// Whether the PUBLIC gateway still answers `eth_getLogs` over the chain's whole
// history. Measured 2026-10-07: Base refuses anything over 1,000 blocks; the
// other four still serve wallet-filtered full-range queries. Capability config,
// not logic — flip an entry when a provider changes, no route edits needed.
const PUBLIC_GATEWAY_SERVES_WIDE_LOGS: Record<ArchiveChain, boolean> = {
  base: false,
  ethereum: true,
  arbitrum: true,
  polygon: true,
  optimism: true,
};

/**
 * False when asking this chain's archive endpoint for wide-range logs is known
 * to be a wasted call, so callers go straight to the transfer-index source
 * (app/lib/evmAssetTransferHistory.ts). An operator-supplied endpoint is assumed
 * capable — that is what it is configured for.
 */
export function archiveServesWideLogs(chain: ArchiveChain): boolean {
  return hasArchiveRpcOverride(chain) || PUBLIC_GATEWAY_SERVES_WIDE_LOGS[chain];
}

/** True when the chain is served by an operator-supplied endpoint, not the public gateway. */
export function hasArchiveRpcOverride(chain: ArchiveChain): boolean {
  return ENV_VARS[chain].some((name) => rpcUrlFromEnv(name) !== '');
}
