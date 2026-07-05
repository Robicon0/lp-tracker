import { NextResponse } from 'next/server';

const HELIUS_KEY = process.env.HELIUS_API_KEY;
const SOLANA_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_PROGRAM_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const KNOWN_TOKENS: Record<string, { symbol: string; name: string; decimals: number; coingeckoId: string }> = {
  'So11111111111111111111111111111111111111112': { symbol: 'SOL', name: 'Wrapped SOL', decimals: 9, coingeckoId: 'solana' },
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { symbol: 'USDC', name: 'USD Coin', decimals: 6, coingeckoId: 'usd-coin' },
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': { symbol: 'USDT', name: 'Tether USD', decimals: 6, coingeckoId: 'tether' },
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': { symbol: 'RAY', name: 'Raydium', decimals: 6, coingeckoId: 'raydium' },
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': { symbol: 'mSOL', name: 'Marinade Staked SOL', decimals: 9, coingeckoId: 'msol' },
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': { symbol: 'ETH', name: 'Wrapped Ether (Wormhole)', decimals: 8, coingeckoId: 'ethereum' },
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': { symbol: 'BONK', name: 'Bonk', decimals: 5, coingeckoId: 'bonk' },
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': { symbol: 'JUP', name: 'Jupiter', decimals: 6, coingeckoId: 'jupiter-exchange-solana' },
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': { symbol: '$WIF', name: 'dogwifhat', decimals: 6, coingeckoId: 'dogwifcoin' },
  'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3': { symbol: 'PYTH', name: 'Pyth Network', decimals: 6, coingeckoId: 'pyth-network' },
  // Sprint 3-FREE: removed the placeholder ORCA entry (`orcaEKTdK7…ABCDE`) — an
  // INVALID Solana pubkey that could never match a real mint (invariant i:
  // value by the on-chain mint, never a hardcoded map).
};

async function rpc(method: string, params: unknown[]) {
  const res = await fetch(SOLANA_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  return json.result;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = searchParams.get('account');

  if (!account) return NextResponse.json({ error: 'account required' }, { status: 400 });
  if (!HELIUS_KEY) return NextResponse.json({ error: 'Helius API key not configured' }, { status: 500 });

  try {
    // SOL native balance + SPL tokens in parallel
    const [solResult, tokenResult1, tokenResult2] = await Promise.all([
      rpc('getBalance', [account]),
      rpc('getTokenAccountsByOwner', [account, { programId: TOKEN_PROGRAM }, { encoding: 'jsonParsed' }]),
      rpc('getTokenAccountsByOwner', [account, { programId: TOKEN_PROGRAM_2022 }, { encoding: 'jsonParsed' }]),
    ]) as [
      { value: number } | null,
      { value: Array<{ account: { data: { parsed: { info: { mint: string; tokenAmount: { uiAmount: number; decimals: number } } } } } }> } | null,
      { value: Array<{ account: { data: { parsed: { info: { mint: string; tokenAmount: { uiAmount: number; decimals: number } } } } } }> } | null,
    ];

    const solBalance = ((solResult?.value ?? 0) / 1e9).toFixed(4);

    const allTokenAccounts = [...(tokenResult1?.value ?? []), ...(tokenResult2?.value ?? [])];

    const tokens = allTokenAccounts
      .filter((ta) => {
        const { uiAmount, decimals } = ta.account.data.parsed.info.tokenAmount;
        return uiAmount != null && uiAmount > 0.00001 && decimals > 0;
      })
      .map((ta) => {
        const info = ta.account.data.parsed.info;
        const known = KNOWN_TOKENS[info.mint];
        return {
          mint: info.mint,
          symbol: known?.symbol || info.mint.slice(0, 6) + '…',
          name: known?.name || 'Unknown Token',
          balance: info.tokenAmount.uiAmount < 1
            ? info.tokenAmount.uiAmount.toFixed(6)
            : info.tokenAmount.uiAmount.toFixed(2),
        };
      });

    return NextResponse.json({ solBalance, tokens });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch Solana balances', details: String(error) }, { status: 500 });
  }
}
