import { NextResponse } from 'next/server';

const ALCHEMY_KEY = process.env.NEXT_PUBLIC_ALCHEMY_KEY;
// Alchemy used only for eth_getBlockByNumber (timestamp lookups) — free tier supports this
const ALCHEMY_RPC = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;
// Blast public RPC used for eth_getLogs — supports full-history scans filtered by tokenId
// (Alchemy free tier caps eth_getLogs at 10 blocks; Blast allows any range when result count < 10K)
const BLAST_RPC = 'https://base-mainnet.public.blastapi.io';

// Aerodrome Slipstream (CL) NonfungiblePositionManager on Base
// Verified: factory() returns 0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A (matches CL_FACTORY)
const NFT_MANAGER = '0x827922686190790b37229fd06084350E74485b72';

// Event topic0 values — computed via keccak256 with viem, verified against live Base chain events
// IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
const TOPIC_INCREASE = '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f';
// DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
const TOPIC_DECREASE = '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4';
// Collect(uint256 indexed tokenId, address recipient, uint256 amount0Collected, uint256 amount1Collected)
const TOPIC_COLLECT = '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01';

export type ActivityEventType = 'deposit' | 'withdrawal' | 'fee_claim';

export interface ActivityEvent {
  type: ActivityEventType;
  txHash: string;
  blockNumber: number;
  timestamp: number;    // unix seconds
  amount0: number;      // human-readable (decimal-adjusted)
  amount1: number;
}

interface ActivityResponse {
  events: ActivityEvent[];
  netInvested0: number;   // sum(deposits) - sum(withdrawals), decimal-adjusted
  netInvested1: number;
  totalFees0: number;     // sum of all Collect events, decimal-adjusted
  totalFees1: number;
}

async function rpcPost(url: string, body: object): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// eth_getLogs via Blast — supports full-history scans when result count < 10K
// A specific tokenId has at most ~20-50 events, so this works across the full chain history
async function fetchLogs(tokenIdHex: string): Promise<RawLog[]> {
  const result = await rpcPost(BLAST_RPC, {
    jsonrpc: '2.0',
    method: 'eth_getLogs',
    params: [{
      address: NFT_MANAGER,
      topics: [
        [TOPIC_INCREASE, TOPIC_DECREASE, TOPIC_COLLECT],
        tokenIdHex,                   // topics[1] = indexed tokenId
      ],
      fromBlock: '0x1000000',         // Base block ~17M (pre-dates all Aerodrome positions)
      toBlock: 'latest',
    }],
    id: 1,
  }) as { result?: RawLog[]; error?: { message: string } };

  if (result.error) {
    console.error('[aerodrome/activity] eth_getLogs error:', result.error);
    return [];
  }
  return result.result ?? [];
}

// Batch-fetch block timestamps using Alchemy (eth_getBlockByNumber works fine on free tier)
async function fetchTimestamps(blockNumbers: number[]): Promise<Record<number, number>> {
  const unique = [...new Set(blockNumbers)];
  const results = await Promise.all(
    unique.map(async (bn) => {
      const res = await rpcPost(ALCHEMY_RPC, {
        jsonrpc: '2.0',
        method: 'eth_getBlockByNumber',
        params: [`0x${bn.toString(16)}`, false],
        id: bn,
      }) as { result?: { timestamp: string } };
      const ts = res.result?.timestamp ? parseInt(res.result.timestamp, 16) : 0;
      return [bn, ts] as [number, number];
    })
  );
  return Object.fromEntries(results);
}

function decodeWord(data: string, wordIndex: number): bigint {
  const start = wordIndex * 64;
  const word = data.slice(start, start + 64);
  if (!word || word.length < 64) return 0n;
  return BigInt('0x' + word);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const positionId = searchParams.get('positionId');   // numeric NFT tokenId string
  const t0d = parseInt(searchParams.get('t0d') ?? '18', 10);
  const t1d = parseInt(searchParams.get('t1d') ?? '18', 10);

  if (!positionId) {
    return NextResponse.json({ error: 'positionId required' }, { status: 400 });
  }
  if (!ALCHEMY_KEY) {
    return NextResponse.json({ error: 'Alchemy key not configured' }, { status: 500 });
  }

  try {
    // Pad tokenId to 32-byte hex topic
    const tokenIdBig = BigInt(positionId);
    const tokenIdHex = '0x' + tokenIdBig.toString(16).padStart(64, '0');

    const logs = await fetchLogs(tokenIdHex);

    if (logs.length === 0) {
      const empty: ActivityResponse = {
        events: [],
        netInvested0: 0,
        netInvested1: 0,
        totalFees0: 0,
        totalFees1: 0,
      };
      return NextResponse.json(empty);
    }

    // Fetch timestamps for all unique block numbers
    const blockNumbers = logs.map(l => parseInt(l.blockNumber, 16));
    const timestamps = await fetchTimestamps(blockNumbers);

    const scale0 = BigInt(10) ** BigInt(t0d);
    const scale1 = BigInt(10) ** BigInt(t1d);

    let deposited0 = 0n, deposited1 = 0n;
    let withdrawn0 = 0n, withdrawn1 = 0n;
    let fees0 = 0n, fees1 = 0n;

    const events: ActivityEvent[] = logs.map((log) => {
      const topic0 = log.topics[0].toLowerCase();
      const blockNum = parseInt(log.blockNumber, 16);
      const timestamp = timestamps[blockNum] ?? 0;
      const data = log.data.startsWith('0x') ? log.data.slice(2) : log.data;

      let type: ActivityEventType;
      let amount0 = 0n, amount1 = 0n;

      if (topic0 === TOPIC_INCREASE) {
        type = 'deposit';
        // data: word0=liquidity(uint128), word1=amount0, word2=amount1
        amount0 = decodeWord(data, 1);
        amount1 = decodeWord(data, 2);
        deposited0 += amount0;
        deposited1 += amount1;
      } else if (topic0 === TOPIC_DECREASE) {
        type = 'withdrawal';
        // data: word0=liquidity(uint128), word1=amount0, word2=amount1
        amount0 = decodeWord(data, 1);
        amount1 = decodeWord(data, 2);
        withdrawn0 += amount0;
        withdrawn1 += amount1;
      } else {
        type = 'fee_claim';
        // data: word0=recipient(address), word1=amount0Collected, word2=amount1Collected
        amount0 = decodeWord(data, 1);
        amount1 = decodeWord(data, 2);
        fees0 += amount0;
        fees1 += amount1;
      }

      return {
        type,
        txHash: log.transactionHash,
        blockNumber: blockNum,
        timestamp,
        amount0: Number(amount0) / Number(scale0),
        amount1: Number(amount1) / Number(scale1),
      };
    });

    // Sort newest first
    events.sort((a, b) => b.blockNumber - a.blockNumber);

    const response: ActivityResponse = {
      events,
      netInvested0: Number(deposited0 - withdrawn0) / Number(scale0),
      netInvested1: Number(deposited1 - withdrawn1) / Number(scale1),
      totalFees0: Number(fees0) / Number(scale0),
      totalFees1: Number(fees1) / Number(scale1),
    };

    return NextResponse.json(response);
  } catch (err) {
    console.error('[aerodrome/activity] Unexpected error:', err);
    return NextResponse.json(
      { error: 'Failed to fetch activity', details: String(err) },
      { status: 500 }
    );
  }
}

interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}
