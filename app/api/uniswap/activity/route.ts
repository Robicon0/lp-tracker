import { NextResponse } from 'next/server';
import { resolveBlockTimestamps } from '../../../lib/blockTimestamps';
import { withActivityRouteCache } from '../../../lib/activityRouteCache';
import { deriveDepositPrices } from '../../../lib/v3PriceDerivation';
import { createHistoricalFeePriceResolver } from '../../../lib/v3HistoricalFeePrice';
import { legPriceFinal, eventPriceFinal } from '../../../lib/priceFinal';
import { prewarmEvmClaimPrices, priceEvmFeeClaim, type EvmClaimSides } from '../../../lib/evmClaimPrice';
import { redisCacheSnapshot } from '../../../lib/redisPriceCache';
import { fetchCachedCoinGeckoPrices } from '../../../lib/priceCache';
import { logPrice } from '../../../lib/priceLogger';
import { getEverOwnedTokenIds } from '../../../lib/evmEverOwnedNftIds';
import { archiveRpcUrl, archiveServesWideLogs, type ArchiveChain } from '../../../lib/evmArchiveRpc';
import { getVerifiedPositionLogs } from '../../../lib/evmAssetTransferHistory';
import { resolveEvmPositionContexts } from '../../../lib/evmPoolContext';
import {
  type RouteTruncation,
  lookupFailureNotice,
  excludedPositionNotices,
  LOOKUP_FAILED,
  LOOKUP_UNAVAILABLE,
} from '../../../lib/enumerationTruncation';
import { alchemyKey } from '../../../lib/alchemyKey';

const ALCHEMY_KEY = alchemyKey();

// Tenderly public gateways — primary for eth_getLogs: full-history, no block-range limit, fast.
// NOTE: no BNB Chain entry — Tenderly has no public BSC gateway. BNB skips
// straight to publicnode chunked via ROLLING_SCAN_DEPTH below.
const ARCHIVE_CHAINS: ArchiveChain[] = ['ethereum', 'arbitrum', 'polygon', 'optimism', 'base'];
const TENDERLY_RPCS: Record<string, string> = Object.fromEntries(ARCHIVE_CHAINS.map((c) => [c, archiveRpcUrl(c)]));

// publicnode: the BNB rolling-window scan, and the second source for block
// timestamps (a reply is used only when it names the block asked for).
const PUBLIC_NODE_RPCS: Record<string, string> = {
  ethereum: 'https://ethereum-rpc.publicnode.com',
  arbitrum: 'https://arbitrum-one-rpc.publicnode.com',
  polygon:  'https://polygon-bor-rpc.publicnode.com',
  optimism: 'https://optimism-rpc.publicnode.com',
  base:     'https://base-rpc.publicnode.com',
  bnb:      'https://bsc-rpc.publicnode.com',
};

// Alchemy RPCs — used only for eth_getBlockByNumber (timestamp lookups)
const ALCHEMY_RPCS: Record<string, string> = {
  ethereum: `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  arbitrum: `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  polygon:  `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  optimism: `https://opt-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  base:     `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  bnb:      `https://bnb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
};

// Uniswap V3 NonfungiblePositionManager per chain. Standard 0xC36442… deploys
// to Ethereum / Arbitrum / Optimism / Polygon, but BNB Chain has a DIFFERENT
// canonical address (Uniswap deployed to BSC in 2023 via governance with its
// own CREATE2 salt). Source: @uniswap/v3-sdk constants.ts.
const NFT_MANAGERS: Record<string, string> = {
  ethereum: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
  arbitrum: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
  polygon:  '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
  optimism: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
  base:     '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
  bnb:      '0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613',
};

// Approximate deployment block per chain (numeric, used for chunked fallback scanning)
const DEPLOY_BLOCKS: Record<string, number> = {
  ethereum: 12_369_140,  // Uniswap V3 launch May 2021
  arbitrum:    165_216,  // Uniswap V3 on Arbitrum launch
  polygon:  22_761_331,  // Uniswap V3 on Polygon launch
  optimism:   3_000_000, // Uniswap V3 on Optimism launch
  base:       1_371_680, // Uniswap V3 on Base launch
  bnb:      26_324_000,  // Uniswap V3 on BNB Chain launch (March 2023, ~block 26.3M)
};

// BSC free-tier public RPCs (publicnode, Alchemy free, LlamaRPC) all PRUNE
// archive history aggressively — publicnode keeps only ~50,000 blocks
// (≈42 hours at 3s block time) and returns "History has been pruned" for
// anything older. With no free-tier archive path the route falls back to a
// rolling window for any chain listed here: scan latestBlock-N → latestBlock
// instead of deploy-block → latestBlock, and gracefully return events:[] when
// chunks fail. Mirrors the pattern in app/api/pancakeswap/activity/route.ts.
// A future upgrade to a paid BSC archive RPC (or BSCSCAN_API_KEY) lifts this.
const ROLLING_SCAN_DEPTH: Record<string, number | undefined> = {
  bnb: 48_000, // ~40 hours, fits inside publicnode's pruning window
};

// publicnode serves up to 49k blocks per getLogs call
const PUBNODE_CHUNK = 49_000;
// Max parallel getLogs requests per batch
const MAX_CONCURRENCY = 50;

// Standard Uniswap V3 event topic0 hashes — same for all V3 forks
// Pool Mint topic (same across all Uniswap-V3 forks) — identifies a
// position's OWN pool from its mint tx receipt.
const POOL_MINT_TOPIC = '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde';
const TOPIC_INCREASE = '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f';
const TOPIC_DECREASE = '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4';
const TOPIC_COLLECT  = '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01';

// Known stablecoins per chain (lowercase addresses)
const STABLECOINS_BY_CHAIN: Record<string, Set<string>> = {
  ethereum: new Set([
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
    '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
    '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI
  ]),
  arbitrum: new Set([
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // USDC
    '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8', // USDC.e
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', // USDT
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', // DAI
  ]),
  polygon: new Set([
    '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', // USDC
    '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', // USDC.e
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', // USDT
    '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063', // DAI
  ]),
  optimism: new Set([
    '0x0b2c639c533813f4aa9d7837caf62653d097ff85', // USDC
    '0x7f5c764cbc14f9669b88837ca1490cca17c31607', // USDC.e
    '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58', // USDT
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', // DAI
  ]),
  base: new Set([
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
    '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', // USDbC
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', // DAI
  ]),
  bnb: new Set([
    '0x55d398326f99059ff775485246999027b3197955', // USDT (18 decimals on BSC)
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', // USDC (18 decimals on BSC)
    '0xe9e7cea3dedca5984780bafc599bd69add087d56', // BUSD
  ]),
};

// CoinGecko historical-daily-price IDs for non-stablecoin tokens per chain.
// Drives fee_claim usdAtTime so claims are valued at market price on the day
// of the claim instead of the pool's internal sqrtPriceX96 ratio. Tokens
// unmapped here fall through to the sqrtPrice resolver. Add new tokens here
// as they surface in user pairs.
const CG_IDS_BY_CHAIN: Record<string, Record<string, string>> = {
  ethereum: {
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'ethereum',       // WETH
    '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 'wrapped-bitcoin', // WBTC
    '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984': 'uniswap',        // UNI
    '0xb50721bcf8d664c30412cfbc6cf7a15145234ad1': 'arbitrum',       // ARB (on eth)
    '0xae78736cd615f374d3085123a210448e74fc6393': 'rocket-pool-eth', // rETH
    '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0': 'wrapped-steth',  // wstETH
  },
  arbitrum: {
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': 'ethereum',       // WETH
    '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f': 'wrapped-bitcoin', // WBTC
    '0x912ce59144191c1204e64559fe8253a0e49e6548': 'arbitrum',       // ARB
  },
  polygon: {
    '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619': 'ethereum',       // WETH
    '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6': 'wrapped-bitcoin', // WBTC
    '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270': 'matic-network',  // WMATIC
    '0x0000000000000000000000000000000000001010': 'matic-network',  // MATIC (system)
  },
  optimism: {
    '0x4200000000000000000000000000000000000006': 'ethereum',       // WETH
    '0x4200000000000000000000000000000000000042': 'optimism',       // OP
    '0x68f180fcce6836688e9084f035309e29bf0a2095': 'wrapped-bitcoin', // WBTC
  },
  base: {
    '0x4200000000000000000000000000000000000006': 'ethereum',       // WETH
  },
  bnb: {
    '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': 'binancecoin',    // WBNB
    '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c': 'bitcoin',        // BTCB (1:1 BTC)
    '0x2170ed0880ac9a755fd29b2688956bd959f933f8': 'ethereum',       // ETH on BSC
  },
};

export type ActivityEventType = 'deposit' | 'withdrawal' | 'fee_claim';

export interface ActivityEvent {
  type: ActivityEventType;
  txHash: string;
  blockNumber: number;
  timestamp: number;
  amount0: number;
  amount1: number;
  usdAtTime: number | null;
  // Per-event historical prices (null when no CoinGecko mapping for the token).
  price0AtTime: number | null;
  price1AtTime: number | null;
  // ITEM 0b — set ONLY when this event's claim-date historical price was cold
  // and CURRENT SPOT was substituted. Consumers treat it as not-yet-final.
  priceBasis?: 'current-spot-substituted' | 'tick-derived-estimate';
  // No price source covers this leg; the client does not retry it (priceFinal.ts).
  priceFinal?: true;
  cumulativeFeeUSD: number;
}

interface ActivityResponse {
  events: ActivityEvent[];
  netInvested0: number;
  netInvested1: number;
  totalFees0: number;
  totalFees1: number;
}

interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}

async function rpcPost(url: string, body: object): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function fetchLogsChunked(
  nftManager: string,
  tokenIdHex: string,
  fromBlock: number,
  toBlock: number,
  rpcUrl: string,
  chunkSize: number,
): Promise<RawLog[]> {
  const chunks: Array<[number, number]> = [];
  for (let b = fromBlock; b <= toBlock; b += chunkSize) {
    chunks.push([b, Math.min(b + chunkSize - 1, toBlock)]);
  }
  console.log(`[uniswap/activity] chunked scan: ${chunks.length} chunks @ ${chunkSize} blocks, rpc=${rpcUrl}`);

  const allLogs: RawLog[] = [];
  for (let i = 0; i < chunks.length; i += MAX_CONCURRENCY) {
    const batch = chunks.slice(i, i + MAX_CONCURRENCY);
    let batchErrors = 0;
    const results = await Promise.all(
      batch.map(async ([from, to]) => {
        const res = await rpcPost(rpcUrl, {
          jsonrpc: '2.0',
          method: 'eth_getLogs',
          params: [{
            address: nftManager,
            topics: [[TOPIC_INCREASE, TOPIC_DECREASE, TOPIC_COLLECT], tokenIdHex],
            fromBlock: '0x' + from.toString(16),
            toBlock:   '0x' + to.toString(16),
          }],
          id: from,
        }) as { result?: RawLog[]; error?: { message: string } };
        if (res.error) {
          batchErrors++;
          return [] as RawLog[];
        }
        return res.result ?? [];
      })
    );
    allLogs.push(...results.flat());
    if (i === 0 && batchErrors === batch.length) {
      throw new Error(`[uniswap/activity] chunked scan: first batch 100% error rate on ${rpcUrl}`);
    }
  }
  return allLogs;
}

// The position's history could not be read and checked against the chain.
// Answered as 503 `history-unverified`; the page shows "history couldn't be loaded".
class HistoryUnverifiedError extends Error {
  constructor() { super('history-unverified'); this.name = 'HistoryUnverifiedError'; }
}

async function fetchLogs(
  chain: string,
  alchemyRpc: string,
  tokenIdHex: string,
  owner: string,
): Promise<RawLog[]> {
  const nftManager = NFT_MANAGERS[chain];
  if (!nftManager) {
    console.warn('[uniswap/activity] no NFT manager configured for chain:', chain);
    return [];
  }
  const deployBlock   = DEPLOY_BLOCKS[chain] ?? 0;
  const tenderlyRpc   = TENDERLY_RPCS[chain];
  const pubNodeRpc    = PUBLIC_NODE_RPCS[chain];
  const rollingDepth  = ROLLING_SCAN_DEPTH[chain];

  // ── BNB Chain rolling-window path ────────────────────────────────────
  // BSC free RPCs prune archive history (~50k block window on publicnode).
  // Skip full-range Tenderly/LlamaRPC attempts (they'll fail with a
  // "history pruned" error) and chunk-scan only the recent window.
  // Older deposits surface as missing — the consumer (computePositionPnL)
  // returns {ok:false, reason:'no_deposits'} and the UI shows
  // "Entry data unavailable" gracefully. Same pattern as
  // app/api/pancakeswap/activity/route.ts.
  if (rollingDepth) {
    if (!pubNodeRpc) return [];
    const bnRes = await rpcPost(alchemyRpc, {
      jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1,
    }) as { result?: string; error?: unknown };
    const currentBlock = bnRes.result ? parseInt(bnRes.result, 16) : deployBlock + rollingDepth;
    const fromBlock = Math.max(deployBlock, currentBlock - rollingDepth);
    try {
      return await fetchLogsChunked(nftManager, tokenIdHex, fromBlock, currentBlock, pubNodeRpc, PUBNODE_CHUNK);
    } catch (err) {
      console.warn(`[uniswap/activity] ${chain} rolling-window scan failed — returning empty:`, String(err));
      return [];
    }
  }

  // A chain whose archive endpoint cannot serve wide-range logs (Base) reads
  // the position's events from the holder's transfer-index history, only when
  // they reconcile with the chain. Every fallback below asks for wide-range
  // logs, so a position that does not reconcile answers 503
  // `history-unverified` at once (same as Aerodrome), never an empty history.
  const indexChain = ARCHIVE_CHAINS.find((c) => c === chain);
  if (indexChain && !archiveServesWideLogs(indexChain)) {
    const viaTransfers = owner
      ? await getVerifiedPositionLogs({ chain: indexChain, nftManager, tokenId: BigInt(tokenIdHex).toString(), owner })
      : null;
    if (viaTransfers) return viaTransfers;
    throw new HistoryUnverifiedError();
  }

  const logsParams = {
    address: nftManager,
    topics: [[TOPIC_INCREASE, TOPIC_DECREASE, TOPIC_COLLECT], tokenIdHex],
    fromBlock: '0x' + deployBlock.toString(16),
    toBlock: 'latest' as const,
  };

  // Tier 1: Tenderly (full-range, no limits, fast)
  if (tenderlyRpc) {
    // A transport failure (gateway down) is an error like any other, so the
    // transfer index below still answers instead of the request failing.
    const tenderlyAttempt = await (rpcPost(tenderlyRpc, {
      jsonrpc: '2.0', method: 'eth_getLogs', params: [logsParams], id: 1,
    }) as Promise<{ result?: RawLog[]; error?: { message: string; code?: number } }>)
      .catch((e: unknown) => ({ result: undefined, error: { message: `unreachable: ${String(e)}`, code: -32603 } }));
    if (!tenderlyAttempt.error) {
      return tenderlyAttempt.result ?? [];
    }
    console.warn('[uniswap/activity] Tenderly error:', chain, tenderlyAttempt.error.message);

    // Tier 1a: the holder's transfer-index history, used only when it reconciles.
    const archiveChain = ARCHIVE_CHAINS.find((c) => c === chain);
    if (archiveChain) {
      const viaTransfers = await getVerifiedPositionLogs({
        chain: archiveChain, nftManager, tokenId: BigInt(tokenIdHex).toString(), owner,
      });
      if (viaTransfers) return viaTransfers;
    }
  }

  // No live secondary: every llamarpc host is gone (arb1 / polygon / op / binance
  // NXDOMAIN, eth / base HTTP 525, 2026-10-28) and publicnode refuses archive
  // logs (403). The history could not be read and checked.
  throw new HistoryUnverifiedError();
}

async function fetchTimestamps(alchemyRpc: string, blockNumbers: number[]): Promise<Record<number, number>> {
  const unique = [...new Set(blockNumbers)];
  const out: Record<number, number> = {};
  // Batch (avoid storming the RPC — wallet-scope can imply hundreds of unique
  // blocks) and wrap each lookup so a transient malformed/429 response yields
  // ts=0 instead of throwing and 500-ing the whole route.
  const CONC = 30;
  for (let i = 0; i < unique.length; i += CONC) {
    const results = await Promise.all(
      unique.slice(i, i + CONC).map(async (bn) => {
        try {
          const res = await rpcPost(alchemyRpc, {
            jsonrpc: '2.0',
            method: 'eth_getBlockByNumber',
            params: [`0x${bn.toString(16)}`, false],
            id: bn,
          }) as { result?: { timestamp: string } };
          const ts = res.result?.timestamp ? parseInt(res.result.timestamp, 16) : 0;
          return [bn, ts] as [number, number];
        } catch {
          return [bn, 0] as [number, number];
        }
      })
    );
    for (const [bn, ts] of results) out[bn] = ts;
  }
  return out;
}


function decodeWord(data: string, wordIndex: number): bigint {
  const start = wordIndex * 64;
  const word = data.slice(start, start + 64);
  if (!word || word.length < 64) return 0n;
  return BigInt('0x' + word);
}

export const GET = withActivityRouteCache(GET_impl);

async function GET_impl(request: Request) {
  // Sprint 1.6: baseline for this invocation's Redis hit/miss delta (the
  // counters are process-wide; the route_summary emission below subtracts this).
  const __redisBaseline = redisCacheSnapshot();
  const { searchParams } = new URL(request.url);
  const chain     = searchParams.get('chain') ?? '';       // ethereum | arbitrum | polygon | optimism
  const tokenId   = searchParams.get('tokenId') ?? '';     // numeric NFT tokenId string
  const t0d       = parseInt(searchParams.get('t0d') ?? '18', 10);
  const t1d       = parseInt(searchParams.get('t1d') ?? '18', 10);
  const token0    = (searchParams.get('token0') ?? '').toLowerCase();
  const token1    = (searchParams.get('token1') ?? '').toLowerCase();
  const fallback0 = parseFloat(searchParams.get('p0') ?? '0');
  const fallback1 = parseFloat(searchParams.get('p1') ?? '0');
  const tickLower = searchParams.get('tickLower') != null ? parseInt(searchParams.get('tickLower')!, 10) : null;
  const tickUpper = searchParams.get('tickUpper') != null ? parseInt(searchParams.get('tickUpper')!, 10) : null;
  const pool      = (searchParams.get('pool') ?? '').toLowerCase();
  // Wallet-scope mode: tokenId=all (or positionId=all) + account scans EVERY
  // tokenId this wallet ever owned ON THIS CHAIN (incl. burned NFTs the position
  // route can't return) and unions their Collect events. Per-tokenId mode is
  // unchanged. Mirrors the Aerodrome positionId=all pattern.
  const account = (searchParams.get('account') ?? '').toLowerCase();
  const walletScope = tokenId === 'all' || searchParams.get('positionId') === 'all';
  const owner = (searchParams.get('owner') ?? '').toLowerCase();

  if (!chain) {
    return NextResponse.json({ error: 'chain required' }, { status: 400 });
  }
  if (!walletScope && !tokenId) {
    return NextResponse.json({ error: 'chain and tokenId required' }, { status: 400 });
  }
  if (walletScope && !account) {
    return NextResponse.json({ error: 'account required for tokenId=all' }, { status: 400 });
  }
  if (!ALCHEMY_RPCS[chain]) {
    return NextResponse.json({ error: `Unsupported chain: ${chain}` }, { status: 400 });
  }
  if (!ALCHEMY_KEY) {
    return NextResponse.json({ error: 'Alchemy key not configured' }, { status: 500 });
  }

  try {
    const alchemyRpc = ALCHEMY_RPCS[chain];

    // ── WALLET SCOPE ────────────────────────────────────────────────────
    // Process EACH ever-owned tokenId through this same route with ITS OWN
    // resolved pool context, then merge.
    //
    // This replaces a BATCHED array-topic getLogs that unioned every tokenId's
    // logs and decoded them all with one representative pool's decimals. The
    // batching saved RPC calls precisely BY discarding which position each log
    // belonged to — which is the bug. Correctness wins: the fan-out is bounded
    // by MAX_WALLET_IDS exactly as the batch was, and per-position results are
    // individually cacheable.
    //
    // Removing this also removes the need for the `<= $50M` artifact filter in
    // useWalletLevelFees, which was a band-aid that only ever caught the
    // INFLATION direction and never the (more dangerous, plausible-looking)
    // crushing direction. See app/lib/evmPoolContext.ts.
    if (walletScope) {
      // Queue item C Phase 2c. Raised 30 -> 150. Unlike the Phase 2a open-position
      // enumeration this fan-out is NOT cheap and NOT batchable: each id costs a
      // full per-position sub-scan (archive eth_getLogs + claim-date pricing),
      // run SERIALLY below, so an unbounded count here is the ITEM 0i shape.
      // The count bound is therefore raised rather than removed, and paired with
      // a wall-clock budget — the same "bound the WORK, disclose the remainder"
      // shape Phase 2a settled on. In practice the budget usually binds first,
      // which is the honest outcome: a wallet gets every position the time
      // allows and is TOLD about the rest, instead of a silent 30.
      const MAX_WALLET_IDS = 150;
      const WALLET_SCOPE_BUDGET_MS = 120_000;
      const archiveRpc = TENDERLY_RPCS[chain];
      const nftManager = NFT_MANAGERS[chain];
      if (!archiveRpc || !nftManager) {
        return NextResponse.json({
          events: [], netInvested0: 0, netInvested1: 0, totalFees0: 0, totalFees1: 0,
          positions: [], excluded: [{ tokenId: 'all', reason: 'no-archive-rpc-for-chain' }],
          // Said out loud: with no history source the whole scan is missing.
          truncated: [lookupFailureNotice(chain.charAt(0).toUpperCase() + chain.slice(1), LOOKUP_UNAVAILABLE)],
        });
      }
      // Anchored HERE, not at the loop: the ever-owned scan and the per-id
      // context resolution below are themselves expensive (measured 83 s for
      // 150 ids on a market-maker wallet), so a budget that started at the loop
      // bounded only part of the work and let the request reach 203 s. One
      // budget for the whole block keeps the route predictable.
      const deadline = Date.now() + WALLET_SCOPE_BUDGET_MS;
      const enumeration = await getEverOwnedTokenIds(
        nftManager, account, archiveRpc, DEPLOY_BLOCKS[chain] ?? 0,
        ARCHIVE_CHAINS.find((c) => c === chain),
      );
      const allIds = enumeration.ids;
      const ids = allIds.slice(0, MAX_WALLET_IDS);
      // Queue item C Phase 1 — the dropped ids used to vanish without a trace,
      // even though this route already had an `excluded[]` channel sitting right
      // there. They now go into BOTH: `excluded[]` (so the existing per-position
      // exclusion plumbing sees them) and `truncated` (so the wallet-level
      // banner can say the Capital G/L below is computed over a partial set).
      const overflowIds = allIds.slice(MAX_WALLET_IDS);
      if (overflowIds.length > 0) {
        console.warn(`[uniswap/activity] tokenId=all chain=${chain}: ${allIds.length} ever-owned ids, cap is ${MAX_WALLET_IDS} — ${overflowIds.length} not scanned`);
      }
      const ctxs = await resolveEvmPositionContexts(ids, {
        chain: chain as Parameters<typeof resolveEvmPositionContexts>[1]['chain'],
        rpc: archiveRpc,
        nftManager,
        increaseTopic: TOPIC_INCREASE,
        poolMintTopic: POOL_MINT_TOPIC,
        deployBlock: DEPLOY_BLOCKS[chain] ?? 0,
      }, 4, enumeration.history?.mintTx ?? {});

      const origin = new URL(request.url).origin;
      const perPosition: Array<Record<string, unknown>> = [];
      const excluded: Array<{ tokenId: string; reason: string }> = overflowIds.map((tokenId) => ({
        tokenId, reason: 'wallet-scope-id-cap',
      }));
      const merged: ActivityEvent[] = [];
      let ni0 = 0, ni1 = 0, tf0 = 0, tf1 = 0;

      const timedOutIds: string[] = [];
      for (const id of ids) {
        // Stop cleanly at the budget rather than being killed mid-scan: an
        // aborted invocation returns nothing at all, while stopping here returns
        // every position scanned so far AND names the ones it could not reach.
        if (Date.now() >= deadline) { timedOutIds.push(id); continue; }
        const ctx = ctxs.get(id) ?? null;
        if (!ctx) {
          // Honest degradation (Rule 11): excluded and surfaced, NEVER decoded
          // with a foreign pool's decimals.
          excluded.push({ tokenId: id, reason: 'pool-context-unresolved' });
          continue;
        }
        const sub = new URL('/api/uniswap/activity', origin);
        sub.searchParams.set('tokenId', id);
        sub.searchParams.set('chain', chain);
        sub.searchParams.set('token0', ctx.token0);
        sub.searchParams.set('token1', ctx.token1);
        sub.searchParams.set('t0d', String(ctx.decimals0));
        sub.searchParams.set('t1d', String(ctx.decimals1));
        sub.searchParams.set('pool', ctx.pool);
        sub.searchParams.set('owner', account);
        try {
          const res = await GET_impl(new Request(sub.toString()));
          const body = (await res.json()) as ActivityResponse & { error?: string };
          if (body.error) { excluded.push({ tokenId: id, reason: body.error }); continue; }
          merged.push(...(body.events ?? []));
          ni0 += body.netInvested0 ?? 0; ni1 += body.netInvested1 ?? 0;
          tf0 += body.totalFees0 ?? 0;   tf1 += body.totalFees1 ?? 0;
          perPosition.push({
            tokenId: id, pool: ctx.pool, chain,
            pair: `${ctx.symbol0} / ${ctx.symbol1}`,
            token0: ctx.token0, token1: ctx.token1,
            decimals0: ctx.decimals0, decimals1: ctx.decimals1,
            netInvested0: body.netInvested0, netInvested1: body.netInvested1,
            totalFees0: body.totalFees0, totalFees1: body.totalFees1,
            events: body.events ?? [],
          });
        } catch (err) {
          excluded.push({ tokenId: id, reason: String(err).slice(0, 80) });
        }
      }

      // Both shortfalls ride the SAME disclosure channel Phase 1 built: named
      // per id in `excluded[]`, summarised for the banner in `truncated`.
      for (const tokenId of timedOutIds) excluded.push({ tokenId, reason: 'wallet-scope-time-budget' });
      const truncated: RouteTruncation[] = [];
      // Queue item B — a THIRD shortfall joins the two below: the ever-owned
      // enumeration itself may have failed, in which case `allIds` is short and
      // so is every fee total computed from it. Pushed first so it reads before
      // the cap/budget notices, which are consequences of a set we DID see.
      if (!enumeration.complete) {
        truncated.push(lookupFailureNotice(
          chain.charAt(0).toUpperCase() + chain.slice(1),
          enumeration.reason ?? LOOKUP_FAILED,
        ));
      }
      // Just the chain as scope: the client labels this source "<protocol>
      // history scan", so repeating "wallet-scope closed scan" here would read
      // as a stutter in the rendered notice.
      const scopeName = chain.charAt(0).toUpperCase() + chain.slice(1);
      if (overflowIds.length > 0) {
        truncated.push({
          scope: scopeName,
          cap: MAX_WALLET_IDS,
          returned: perPosition.length,
          knownTotal: allIds.length,
          reason: 'wallet-scope-id-cap',
        });
      }
      // Positions the scan knew about and left out (pool not identified, a
      // failed request, the time budget): counted, one notice per cause, and
      // the totals that depend on them show `≈` (standing rule (i)). The time
      // budget used to travel as a cap notice, which marked no total.
      truncated.push(...excludedPositionNotices(scopeName, excluded, ids.length));
      if (timedOutIds.length > 0) {
        console.warn(`[uniswap/activity] tokenId=all chain=${chain}: stopped at the ${WALLET_SCOPE_BUDGET_MS / 1000}s budget — ${timedOutIds.length} of ${ids.length} ids not scanned`);
      }

      console.log(`[uniswap/activity] tokenId=all chain=${chain} account=${account} → ${ids.length} tokenIds, ${perPosition.length} resolved, ${excluded.length} excluded`);

      // Per-position breakdown so a WALLET-WIDE total is never attributed to
      // one position.
      return NextResponse.json({
        events: merged,
        netInvested0: ni0, netInvested1: ni1,
        totalFees0: tf0, totalFees1: tf1,
        positions: perPosition,
        excluded,
        ...(truncated.length > 0 ? { truncated } : {}),
      });
    }

    let logs: RawLog[];
    {
      const tokenIdHex = '0x' + BigInt(tokenId).toString(16).padStart(64, '0');
      logs = await fetchLogs(chain, alchemyRpc, tokenIdHex, owner);
    }

    if (logs.length === 0) {
      const empty: ActivityResponse = { events: [], netInvested0: 0, netInvested1: 0, totalFees0: 0, totalFees1: 0 };
      return NextResponse.json(empty);
    }

    const blockNumbers = logs.map(l => parseInt(l.blockNumber, 16));
    const timestamps = await resolveBlockTimestamps(chain, blockNumbers, (missing) => fetchTimestamps(alchemyRpc, missing), PUBLIC_NODE_RPCS[chain]);

    const scale0 = BigInt(10) ** BigInt(t0d);
    const scale1 = BigInt(10) ** BigInt(t1d);

    let deposited0 = 0n, deposited1 = 0n;
    let withdrawn0 = 0n, withdrawn1 = 0n;
    let fees0 = 0n, fees1 = 0n;

    const TOPIC_MAP: Record<string, ActivityEventType> = {
      [TOPIC_INCREASE]: 'deposit',
      [TOPIC_DECREASE]: 'withdrawal',
      [TOPIC_COLLECT]:  'fee_claim',
    };

    interface RawEvent {
      type: ActivityEventType;
      txHash: string;
      blockNumber: number;
      timestamp: number;
      amount0Raw: bigint;
      amount1Raw: bigint;
    }

    const rawEvents: RawEvent[] = logs.flatMap((log) => {
      const topic0 = log.topics[0].toLowerCase();
      const type = TOPIC_MAP[topic0];
      if (!type) {
        console.error('[uniswap/activity] Unknown topic0 (skipping):', topic0);
        return [];
      }

      const blockNum = parseInt(log.blockNumber, 16);
      const timestamp = timestamps[blockNum] ?? 0;
      const data = log.data.startsWith('0x') ? log.data.slice(2) : log.data;

      // IncreaseLiquidity/DecreaseLiquidity: word0=liquidity, word1=amount0, word2=amount1
      // Collect: word0=recipient(address), word1=amount0Collected, word2=amount1Collected
      const amount0Raw = decodeWord(data, 1);
      const amount1Raw = decodeWord(data, 2);

      return [{ type, txHash: log.transactionHash, blockNumber: blockNum, timestamp, amount0Raw, amount1Raw }];
    });

    // When Collect and DecreaseLiquidity share a tx, Collect includes the
    // withdrawn amounts. Subtract so only actual fees remain.
    const decreaseByTx = new Map<string, { a0: bigint; a1: bigint }>();
    for (const ev of rawEvents) {
      if (ev.type === 'withdrawal') {
        const prev = decreaseByTx.get(ev.txHash);
        decreaseByTx.set(ev.txHash, { a0: (prev?.a0 ?? 0n) + ev.amount0Raw, a1: (prev?.a1 ?? 0n) + ev.amount1Raw });
      }
    }
    for (const ev of rawEvents) {
      if (ev.type === 'fee_claim') {
        const dec = decreaseByTx.get(ev.txHash);
        if (dec) {
          ev.amount0Raw = ev.amount0Raw > dec.a0 ? ev.amount0Raw - dec.a0 : 0n;
          ev.amount1Raw = ev.amount1Raw > dec.a1 ? ev.amount1Raw - dec.a1 : 0n;
        }
      }
    }

    // Drop zero-amount fee_claim artifacts (both amounts clamped to 0 by the
    // Decrease-subtraction pass when a close tx had Collect emitting the same
    // amounts the user withdrew). Contributes $0 but inflates the claim count.
    const cleanRawEvents = rawEvents.filter(
      (ev) => !(ev.type === 'fee_claim' && ev.amount0Raw === 0n && ev.amount1Raw === 0n),
    );

    for (const ev of cleanRawEvents) {
      if (ev.type === 'deposit')    { deposited0 += ev.amount0Raw; deposited1 += ev.amount1Raw; }
      if (ev.type === 'withdrawal') { withdrawn0 += ev.amount0Raw; withdrawn1 += ev.amount1Raw; }
      if (ev.type === 'fee_claim')  { fees0 += ev.amount0Raw;      fees1 += ev.amount1Raw;      }
    }

    // Sort chronologically for cumulative fee calculation
    cleanRawEvents.sort((a, b) => a.blockNumber - b.blockNumber);

    const stablecoins = STABLECOINS_BY_CHAIN[chain] ?? new Set<string>();
    const cgIds = CG_IDS_BY_CHAIN[chain] ?? {};
    const tenderlyRpc = TENDERLY_RPCS[chain];


    // Resolve pool's sqrtPriceX96 at EVERY unique event block (deposits +
    // withdrawals + fee claims) — that gives the exact token0/token1
    // prices at the moment of each event. Especially important for
    // single-sided withdrawals where deriveDepositPrices's tick-boundary
    // estimate is wildly wrong (e.g. "0 token0 + N token1" balloons to
    // amount1 × tick-estimated-price-of-0 instead of amount1 × $1).
    const allBlocks = cleanRawEvents.map((e) => e.blockNumber);
    const histPrices = pool && allBlocks.length > 0 && tenderlyRpc
      ? await (async () => {
          const resolver = createHistoricalFeePriceResolver({
            rpc: tenderlyRpc, pool, token0, token1,
            decimals0: t0d, decimals1: t1d, stablecoins,
            chain, // ITEM 0d — the SAME pool address can exist on several chains

          });
          try { return await resolver.resolveMany(allBlocks); }
          catch (err) { console.error('[uniswap/activity] hist price resolve failed:', err); return null; }
        })()
      : null;

    // PART 1: guarantee a usable current-spot price for the fee_claim
    // fallback, even when the caller passed p0=0 or p1=0. For any zero
    // side that has a per-chain cgIds entry, fetch current spot from
    // CoinGecko's simple/price endpoint. Stablecoins anchor at $1.
    let currentSpot0 = fallback0;
    let currentSpot1 = fallback1;
    // A spot read that threw or came back without a price is a FAILED read:
    // it keeps the position's pricing retry (app/lib/priceFinal.ts).
    let spotReadFailed = false;
    {
      if (currentSpot0 === 0 && stablecoins.has(token0)) currentSpot0 = 1;
      if (currentSpot1 === 0 && stablecoins.has(token1)) currentSpot1 = 1;
      const cg0Spot = !stablecoins.has(token0) && currentSpot0 === 0 ? cgIds[token0] : undefined;
      const cg1Spot = !stablecoins.has(token1) && currentSpot1 === 0 ? cgIds[token1] : undefined;
      const idsNeeded: string[] = [];
      if (cg0Spot) idsNeeded.push(cg0Spot);
      if (cg1Spot) idsNeeded.push(cg1Spot);
      if (idsNeeded.length > 0) {
        try {
          const spots = await fetchCachedCoinGeckoPrices([...new Set(idsNeeded)]);
          if (cg0Spot && spots[cg0Spot] > 0) currentSpot0 = spots[cg0Spot];
          if (cg1Spot && spots[cg1Spot] > 0) currentSpot1 = spots[cg1Spot];
          if ((cg0Spot && !(spots[cg0Spot] > 0)) || (cg1Spot && !(spots[cg1Spot] > 0))) spotReadFailed = true;
        } catch { spotReadFailed = true; /* coerced to 0 by final guard below */ }
      }
    }
    // No price source can ever cover an unpriced or substituted deposit /
    // withdrawal of this position (no stablecoin side, pool known, no failed
    // read): its legs are marked `priceFinal` and the client does not retry it.
    const legsFinal = legPriceFinal({ pool, token0, token1, stablecoins: stablecoins, spotReadFailed });

    // Claim-day prices for every fee claim (Rule 1): one batched DeFiLlama
    // request per pass, stored per coin, awaited so a claim is never valued
    // from a cold cache by luck of timing (10 s cap; a miss stays unpriced).
    const __claimSides: EvmClaimSides = { chain: chain, token0, token1, isStable0: stablecoins.has(token0), isStable1: stablecoins.has(token1) };
    await prewarmEvmClaimPrices(__claimSides, cleanRawEvents.filter((e) => e.type === 'fee_claim').map((e) => e.timestamp));

    const hasTicks = tickLower != null && tickUpper != null;
    let runningFeeUSD = 0;
    // [PRICE_LOG] instrumentation (additive only) — per-request fee_claim counters
    const __route = 'uniswap-v3';
    const __posId = tokenId ?? '';
    const __srcBreakdown: Record<string, number> = {};
    const __failures: Array<{ token: string; blockTimestamp: number; reason: string }> = [];
    let __totalClaims = 0, __resolvedClaims = 0, __failedClaims = 0, __totalLookups = 0;
    const events: ActivityEvent[] = cleanRawEvents.map((ev) => {
      const amount0 = Number(ev.amount0Raw) / Number(scale0);
      const amount1 = Number(ev.amount1Raw) / Number(scale1);

      let price0AtTime: number | null = null;
      let price1AtTime: number | null = null;
      let usdAtTime: number | null = null;
      let priceBasis: 'current-spot-substituted' | 'tick-derived-estimate' | undefined;

      // For deposits/withdrawals, try historical sqrtPrice at the block
      // FIRST. Only fall back to deriveDepositPrices's tick estimate when
      // the resolver has no entry for this block.
      if (ev.type === 'deposit' || ev.type === 'withdrawal') {
        if (histPrices) {
          const hex = '0x' + ev.blockNumber.toString(16);
          const hp = histPrices.get(hex);
          if (hp) {
            price0AtTime = hp.price0Usd;
            price1AtTime = hp.price1Usd;
            usdAtTime = amount0 * hp.price0Usd + amount1 * hp.price1Usd;
          }
        }
        if (usdAtTime == null && hasTicks) {
          const derived = deriveDepositPrices(
            amount0, amount1, tickLower!, tickUpper!, t0d, t1d,
            token0, token1, stablecoins,
          );
          if (derived) {
            price0AtTime = derived.price0;
            price1AtTime = derived.price1;
            usdAtTime = amount0 * derived.price0 + amount1 * derived.price1;
            // ITEM 0b: this is a TICK-BOUNDARY ESTIMATE from the position's own
            // range, not the price at THIS event's block — so every event of the
            // position gets the SAME price, which makes a closed position's
            // deposit and withdrawal converge and its Capital G/L collapse
            // toward $0. Marked so the total declares itself not-yet-final.
            priceBasis = 'tick-derived-estimate';
          }
        }
      }

      // Fee claims (pricing-invariants Rule 1, ITEM 0e): each side at its
      // claim day by contract address — stablecoin $1, otherwise DeFiLlama's
      // day price (an earlier day ≤ 3 back is marked). No price → unpriced and
      // counted on the page; never the pool's price, never today's spot.
      let claimPriceBasis: 'nearby-day' | undefined;
      let __claimSrc = 'unknown';
      if (ev.type === 'fee_claim') {
        const cp = priceEvmFeeClaim(__claimSides, amount0, amount1, ev.timestamp);
        price0AtTime = cp.price0;
        price1AtTime = cp.price1;
        usdAtTime = cp.usd;
        __claimSrc = cp.src;
        if (cp.nearby) claimPriceBasis = 'nearby-day';
      }

      // ITEM 0b: allowed but MARKED — never silently substituted.
      // NOTE: unlike the other routes this branch is NOT gated on
      // `ev.type !== 'fee_claim'`, so a fee claim can reach it — a separate,
      // pre-existing pricing-invariants Rule 1a leak recorded as its own queue
      // item. The marker is set for whatever event lands here; only deposits
      // and withdrawals feed the Capital G/L pending signal.
      if (usdAtTime == null && ev.type !== 'fee_claim') {
        price0AtTime = currentSpot0 || null;
        price1AtTime = currentSpot1 || null;
        if (currentSpot0 > 0 || currentSpot1 > 0) {
          usdAtTime = amount0 * currentSpot0 + amount1 * currentSpot1;
          priceBasis = 'current-spot-substituted';
        }
      }

      let cumulativeFeeUSD = 0;
      if (ev.type === 'fee_claim') {
        runningFeeUSD += usdAtTime ?? 0;
        cumulativeFeeUSD = runningFeeUSD;
      }

      // [PRICE_LOG] fee_claim resolution — read-only re-derivation of the
      // winning price source, mirrors the ladder above without altering values.
      if (ev.type === 'fee_claim') {
        const __src = __claimSrc;
        __totalClaims++; __totalLookups++;
        __srcBreakdown[__src] = (__srcBreakdown[__src] ?? 0) + 1;
        const __ok = usdAtTime != null && usdAtTime > 0;
        if (__ok) __resolvedClaims++;
        else { __failedClaims++; __failures.push({ token: `${token0}/${token1}`, blockTimestamp: ev.timestamp, reason: __src === 'unknown' ? 'no_price_any_source' : 'zero_usd' }); }
        logPrice({
          event: 'fee_claim_resolution',
          route: __route,
          positionId: __posId,
          blockTimestamp: ev.timestamp,
          token0: { symbol: token0, address: token0, amount: String(amount0) },
          token1: { symbol: token1, address: token1, amount: String(amount1) },
          token0Usd: price0AtTime,
          token1Usd: price1AtTime,
          usdAtTime,
          status: (usdAtTime == null || usdAtTime === 0) ? 'failed_null_usdAtTime' : ((price0AtTime != null && price1AtTime != null) ? 'ok' : 'partial'),
          notes: `source=${__src} chain=${chain}`,
        });
      }
      return { type: ev.type, txHash: ev.txHash, blockNumber: ev.blockNumber, timestamp: ev.timestamp, amount0, amount1, usdAtTime, price0AtTime, price1AtTime, ...(priceBasis ? { priceBasis } : {}), ...(eventPriceFinal(ev.type, usdAtTime, priceBasis, legsFinal) ? { priceFinal: true } : {}), ...(claimPriceBasis ? { claimPriceBasis } : {}), cumulativeFeeUSD };
    });

    // Reverse to newest-first for display
    events.reverse();

    // [PRICE_LOG] route_summary — aggregate of this request's fee_claim pricing
    const __redisNow = redisCacheSnapshot();
    logPrice({
      event: 'route_summary',
      route: __route,
      wallet: '',
      totalClaims: __totalClaims,
      resolvedClaims: __resolvedClaims,
      failedClaims: __failedClaims,
      totalLookups: __totalLookups,
      sourceBreakdown: __srcBreakdown,
      failures: __failures,
      // Sprint 1.6 persistent-cache hit/miss for this invocation (snapshot
      // delta vs handler-entry baseline; approximate under concurrent load).
      redis_cache_hits: __redisNow.hits - __redisBaseline.hits,
      redis_cache_misses: __redisNow.misses - __redisBaseline.misses,
    });

    return NextResponse.json({
      events,
      netInvested0: Number(deposited0 - withdrawn0) / Number(scale0),
      netInvested1: Number(deposited1 - withdrawn1) / Number(scale1),
      totalFees0:   Number(fees0) / Number(scale0),
      totalFees1:   Number(fees1) / Number(scale1),
    } satisfies ActivityResponse);
  } catch (err) {
    if (err instanceof HistoryUnverifiedError) {
      console.warn(`[uniswap/activity] ${chain} tokenId=${tokenId}: history could not be verified (transfer index), answering 503`);
      return NextResponse.json({ error: 'history-unverified' }, { status: 503 });
    }
    console.error('[uniswap/activity] Unexpected error:', err);
    return NextResponse.json({ error: 'Failed to fetch activity', details: String(err) }, { status: 500 });
  }
}
