import { NextResponse } from 'next/server';

const SUI_RPC = process.env.SUI_RPC_URL || 'https://fullnode.mainnet.sui.io:443';

const KNOWN_COINS: Record<string, { symbol: string; name: string; decimals: number }> = {
  '0x2::sui::SUI': { symbol: 'SUI', name: 'Sui', decimals: 9 },
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC': { symbol: 'USDC', name: 'USD Coin', decimals: 6 },
  '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN': { symbol: 'USDT', name: 'Tether USD', decimals: 6 },
  '0xaf8cd5edc19c4512f4259f0bee101a40d41ebed738ade5874359610ef8eeced5::coin::COIN': { symbol: 'WETH', name: 'Wrapped Ether', decimals: 8 },
  '0x027792d9fed7f9844eb4839566001bb6f6cb4804f66aa2da6fe1ee242d896881::coin::COIN': { symbol: 'WBTC', name: 'Wrapped Bitcoin', decimals: 8 },
  '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN': { symbol: 'wUSDC', name: 'Wormhole USDC', decimals: 6 },
  '0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS': { symbol: 'CETUS', name: 'Cetus Protocol', decimals: 9 },
  '0xa99b8952d4f7d947ea77fe0ecdcc9e5fc0bcab2841d6e2a5aa00c3044e5544b5::navx::NAVX': { symbol: 'NAVX', name: 'Navi Protocol', decimals: 9 },
  '0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI': { symbol: 'haSUI', name: 'Haedal Staked SUI', decimals: 9 },
};

async function suiRpc(method: string, params: unknown[]) {
  const res = await fetch(SUI_RPC, {
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

  try {
    // suix_getAllBalances returns all coin balances for the address in one call
    const balances = await suiRpc('suix_getAllBalances', [account]) as Array<{
      coinType: string;
      coinObjectCount: number;
      totalBalance: string;
      lockedBalance: Record<string, string>;
    }> | null;

    if (!balances) return NextResponse.json({ suiBalance: '0.0000', tokens: [] });

    const suiEntry = balances.find((b) => b.coinType === '0x2::sui::SUI');
    const suiBalance = suiEntry
      ? (Number(BigInt(suiEntry.totalBalance)) / 1e9).toFixed(4)
      : '0.0000';

    // All other coins (excluding SUI native and zero balances)
    const otherCoins = balances.filter(
      (b) => b.coinType !== '0x2::sui::SUI' && BigInt(b.totalBalance) > 0n,
    );

    // Fetch metadata for unknown coins
    const tokens: Array<{ symbol: string; name: string; balance: string; coinType: string }> = [];
    await Promise.all(
      otherCoins.map(async (coin) => {
        let meta = KNOWN_COINS[coin.coinType];
        if (!meta) {
          try {
            const result = await suiRpc('suix_getCoinMetadata', [coin.coinType]) as
              { decimals: number; symbol: string; name: string } | null;
            if (result) {
              meta = { symbol: result.symbol, name: result.name, decimals: result.decimals };
            }
          } catch { /* skip */ }
        }
        if (!meta) return;

        const rawBalance = Number(BigInt(coin.totalBalance)) / 10 ** meta.decimals;
        if (rawBalance < 0.000001) return;

        tokens.push({
          symbol: meta.symbol,
          name: meta.name,
          balance: rawBalance < 1 ? rawBalance.toFixed(6) : rawBalance.toFixed(2),
          coinType: coin.coinType,
        });
      }),
    );

    // Sort: stablecoins first, then by name
    tokens.sort((a, b) => {
      const stables = ['USDC', 'USDT', 'wUSDC'];
      const aStable = stables.includes(a.symbol) ? 0 : 1;
      const bStable = stables.includes(b.symbol) ? 0 : 1;
      return aStable - bStable || a.symbol.localeCompare(b.symbol);
    });

    return NextResponse.json({ suiBalance, tokens });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch Sui balances', details: String(error) },
      { status: 500 },
    );
  }
}
