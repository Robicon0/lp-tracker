// Enumerate every ERC-721 tokenId an EVM wallet has EVER received (mint OR
// transfer-in) from a given NFT manager, by scanning Transfer(_, to, tokenId)
// logs with `to = wallet`. This recovers positions whose NFT was later BURNED
// on close — Slipstream forks (Aerodrome / Velodrome) burn the position NFT on
// full exit, so the protocol's position-discovery contract (e.g. Aerodrome
// Sugar) can no longer return them, yet their Collect (fee-claim) logs remain
// permanently on-chain and indexed by tokenId.
//
// Reusable across EVM V3 / Slipstream forks (Aerodrome now; Velodrome and
// Uniswap V3 defensively later — they share the same per-tokenId discovery gap).
//
// `rpc` MUST be archive-capable with no eth_getLogs block-range limit (Tenderly
// public gateways qualify: base/optimism/arbitrum/mainnet/polygon .gateway.tenderly.co).
// Returns decimal tokenId strings; callers BigInt() them for hex padding and
// Number() them for block estimation (Aerodrome/Velodrome/UniV3 tokenIds are
// all well under 2^53).

import { LOOKUP_FAILED, LOOKUP_UNAVAILABLE } from './enumerationTruncation';

const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * Result of an ever-owned enumeration.
 *
 * `complete` is the load-bearing field (queue item B). An empty `ids` with
 * `complete: true` means "this wallet genuinely never owned one". An empty `ids`
 * with `complete: false` means "we do not know" — and the two must NEVER render
 * the same way, because the second one silently deletes real closed positions
 * (and their Capital G/L) from user-facing totals.
 *
 * Deliberately NOT a bare `string[]` any more: the old signature made the unsafe
 * reading the DEFAULT one. A caller had to remember that `[]` might be a lie.
 * Now the type forces the question, which is the only durable fix — this is the
 * fifth occurrence of this failure class in this codebase (`suiRpcIndexed`, the
 * Sui self-disconnect, the Solana empty-cache rule, vfat's partial empty, and
 * this), and every previous fix was local.
 */
export interface EverOwnedResult {
  /** Decimal tokenId strings. Possibly PARTIAL — check `complete` first. */
  ids: string[];
  /** True only when the scan provably saw the whole range. */
  complete: boolean;
  /**
   * Why the scan was incomplete. `lookup-failed` = transient (errored call).
   * `lookup-unavailable` = the RPC cannot serve this at all (no archive
   * endpoint, or the provider withdrew full-range eth_getLogs). Null when
   * complete.
   */
  reason: typeof LOOKUP_FAILED | typeof LOOKUP_UNAVAILABLE | null;
}

const COMPLETE_EMPTY: EverOwnedResult = { ids: [], complete: true, reason: null };

/**
 * A provider that refuses the query outright (block-range cap, archive gated
 * behind a key) is UNAVAILABLE, not merely failing: retrying cannot help, and
 * the notice should not imply it might. Matched on the error text because these
 * arrive as generic `-32602 invalid params` / `-32000` with the real cause only
 * in the message. Observed live 2026-09-19 across three providers:
 *   Tenderly    -32602 "Block range too large for public access: maximum 1000 blocks"
 *   publicnode  -32602 "Archive requests require a personal token"
 *   Alchemy     -32600 "you can make eth_getLogs requests with up to a 10 block range"
 */
function classifyRpcError(
  message: string | undefined,
  data?: unknown,
): typeof LOOKUP_FAILED | typeof LOOKUP_UNAVAILABLE {
  // The USEFUL text is often in `error.data`, not `error.message`. Tenderly's cap
  // arrives as message "invalid params" with data "Block range too large for
  // public access: maximum 1000 blocks" — classifying on message alone read a
  // hard capability limit as a transient blip (caught in verification).
  const m = `${message ?? ''} ${typeof data === 'string' ? data : JSON.stringify(data ?? '')}`.toLowerCase();
  const unavailable =
    m.includes('block range') ||
    m.includes('range too large') ||
    m.includes('ranges over') ||
    m.includes('archive request') ||
    m.includes('personal token') ||
    m.includes('upgrade') ||
    m.includes('not supported') ||
    m.includes('api key');
  return unavailable ? LOOKUP_UNAVAILABLE : LOOKUP_FAILED;
}

export async function getEverOwnedTokenIds(
  nftManager: string,
  wallet: string,
  rpc: string,
  fromBlock: number,
): Promise<EverOwnedResult> {
  // No wallet is not a failure — there is genuinely nothing to enumerate.
  if (!wallet) return COMPLETE_EMPTY;
  // An unset/malformed RPC cannot serve the scan. That is a CONFIGURATION gap,
  // so it is `unavailable` and must be disclosed, never reported as "none owned".
  if (!rpc) {
    console.warn('[evmEverOwnedNftIds] no archive RPC configured — cannot enumerate ever-owned tokenIds');
    return { ids: [], complete: false, reason: LOOKUP_UNAVAILABLE };
  }
  const paddedWallet = '0x' + wallet.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  try {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getLogs',
        params: [{
          address: nftManager,
          // topic1 (from) = any; topic2 (to) = wallet → every NFT received.
          topics: [TRANSFER_TOPIC, null, paddedWallet],
          fromBlock: '0x' + fromBlock.toString(16),
          toBlock: 'latest',
        }],
      }),
    });
    const j = (await res.json()) as {
      result?: Array<{ topics: string[] }>;
      error?: { message: string; data?: unknown };
    };
    if (j.error || !Array.isArray(j.result)) {
      const reason = classifyRpcError(j.error?.message, j.error?.data);
      console.warn(
        `[evmEverOwnedNftIds] getLogs error (${reason}):`,
        j.error?.message,
        j.error?.data ?? '',
        '— reporting INCOMPLETE, not "no positions"',
      );
      return { ids: [], complete: false, reason };
    }
    const ids = new Set<string>();
    for (const log of j.result) {
      const tid = log.topics?.[3]; // tokenId is the 3rd indexed topic
      if (tid) ids.add(BigInt(tid).toString());
    }
    return { ids: [...ids], complete: true, reason: null };
  } catch (err) {
    console.error('[evmEverOwnedNftIds] fetch failed:', err, '— reporting INCOMPLETE, not "no positions"');
    return { ids: [], complete: false, reason: LOOKUP_FAILED };
  }
}
