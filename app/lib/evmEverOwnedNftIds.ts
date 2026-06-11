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

const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export async function getEverOwnedTokenIds(
  nftManager: string,
  wallet: string,
  rpc: string,
  fromBlock: number,
): Promise<string[]> {
  if (!wallet) return [];
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
      error?: { message: string };
    };
    if (j.error || !Array.isArray(j.result)) {
      console.warn('[evmEverOwnedNftIds] getLogs error:', j.error?.message);
      return [];
    }
    const ids = new Set<string>();
    for (const log of j.result) {
      const tid = log.topics?.[3]; // tokenId is the 3rd indexed topic
      if (tid) ids.add(BigInt(tid).toString());
    }
    return [...ids];
  } catch (err) {
    console.error('[evmEverOwnedNftIds] fetch failed:', err);
    return [];
  }
}
