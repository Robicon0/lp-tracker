import { NextResponse } from 'next/server';

// HyperLend on HyperEVM — Aave V3 fork
// Docs: https://docs.hyperlend.finance/developer-documentation/contract-addresses
//
// Flow:
//   1. Pool.getUserAccountData(user) — quick check: any collateral or debt?
//   2. Pool.getReservesList() — all asset addresses (17 reserves)
//   3. For each reserve: DataProvider.getUserReserveData(asset, user) — supply/borrow amounts + supply APY
//   4. Filter to non-zero balances
//   5. For active reserves: DataProvider.getReserveData(asset) — borrow APY; ERC20.symbol/decimals
//   6. CoinGecko prices (stables short-circuited to $1)
//
// Rates are in RAY (1e27 = 100%/year). Convert: aprPct = rate / 1e27 * 100

const HYPEREVM_RPC = 'https://rpc.hyperliquid.xyz/evm';
const POOL          = '0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b';
const DATA_PROVIDER = '0x5481bf8d3946E6A3168640c1D7523eB59F055a29';

// Aave V3 function selectors
const SEL_USER_ACCOUNT  = '0xbf92857c'; // Pool.getUserAccountData(address)
const SEL_RESERVES_LIST = '0xd1946dbc'; // Pool.getReservesList()
const SEL_USER_RESERVE  = '0x28dd2d01'; // DataProvider.getUserReserveData(address,address)
const SEL_RESERVE_DATA  = '0x35ea6a75'; // DataProvider.getReserveData(address)
const SEL_SYMBOL        = '0x95d89b41'; // ERC20.symbol()
const SEL_DECIMALS      = '0x313ce567'; // ERC20.decimals()

function padAddr(addr: string): string {
  return '000000000000000000000000' + addr.toLowerCase().replace('0x', '');
}

async function ethCall(to: string, data: string): Promise<string> {
  const res = await fetch(HYPEREVM_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'eth_call',
      params: [{ to, data }, 'latest'],
    }),
  });
  const json = await res.json() as { result?: string; error?: { message: string } };
  if (json.error) throw new Error(`HyperEVM RPC: ${json.error.message}`);
  return json.result ?? '0x';
}

function word(hex: string, idx: number): bigint {
  const raw = hex.replace('0x', '');
  const slice = raw.slice(idx * 64, idx * 64 + 64);
  if (!slice || slice.length < 64) return 0n;
  return BigInt('0x' + slice);
}

// Decode ABI-encoded dynamic string (offset/length/data)
function decodeString(hex: string): string {
  try {
    const raw = hex.replace('0x', '');
    const len = parseInt(raw.slice(64, 128), 16);
    if (len === 0) return '';
    const bytes = raw.slice(128, 128 + len * 2);
    let str = '';
    for (let i = 0; i < bytes.length; i += 2) {
      str += String.fromCharCode(parseInt(bytes.slice(i, i + 2), 16));
    }
    return str.replace(/\0/g, '').trim();
  } catch { return ''; }
}

// Decode address array: [offset(32), count(32), addr(32)...]
function decodeAddressArray(hex: string): string[] {
  const raw = hex.replace('0x', '');
  if (raw.length < 128) return [];
  const offset = parseInt(raw.slice(0, 64), 16) * 2;
  const count = parseInt(raw.slice(offset, offset + 64), 16);
  const addrs: string[] = [];
  for (let i = 0; i < count; i++) {
    const w = raw.slice(offset + 64 + i * 64, offset + 64 + i * 64 + 64);
    addrs.push('0x' + w.slice(-40));
  }
  return addrs;
}

// Cache reserves list — changes rarely
let _reservesCache: { addrs: string[]; ts: number } | null = null;

async function getReservesList(): Promise<string[]> {
  if (_reservesCache && Date.now() - _reservesCache.ts < 60_000) return _reservesCache.addrs;
  const hex = await ethCall(POOL, SEL_RESERVES_LIST);
  const addrs = decodeAddressArray(hex);
  _reservesCache = { addrs, ts: Date.now() };
  return addrs;
}

// ── Pricing ──────────────────────────────────────────────────────────────────

const STABLE_SYMBOLS = new Set([
  'USDC', 'USDT', 'USDT0', 'USDHL', 'USR', 'USDH', 'USDXL', 'DAI', 'FDUSD',
  'USDA', 'USDN', 'USDS', 'USDE', 'PYUSD', 'FRAX', 'LUSD', 'GHO', 'CRVUSD',
]);

const CG_IDS: Record<string, string> = {
  HYPE: 'hyperliquid', WHYPE: 'hyperliquid',
  WSTHYPE: 'hyperliquid', KHYPE: 'hyperliquid',
  BEHYPE: 'hyperliquid', LHYPE: 'hyperliquid',
  UBTC: 'bitcoin', WBTC: 'bitcoin', BTC: 'bitcoin', CBBTC: 'bitcoin', TBTC: 'bitcoin',
  UETH: 'ethereum', WETH: 'ethereum', ETH: 'ethereum',
  STETH: 'staked-ether', WSTETH: 'wrapped-steth',
  CBETH: 'coinbase-wrapped-staked-eth', RETH: 'rocket-pool-eth',
  WEETH: 'wrapped-eeth', EZETH: 'renzo-restaked-eth', RSETH: 'kelp-dao-restaked-eth',
  SUSDE: 'ethena-staked-usde',
  USOL: 'solana', SOL: 'solana', WSOL: 'solana',
  SUI: 'sui',
  AAVE: 'aave', LINK: 'chainlink', UNI: 'uniswap', CRV: 'curve-dao-token',
  MKR: 'maker', LDO: 'lido-dao', ARB: 'arbitrum', OP: 'optimism',
  MATIC: 'matic-network', POL: 'matic-network',
  BNB: 'binancecoin', AVAX: 'avalanche-2',
};

const _priceCache: Record<string, { price: number; ts: number }> = {};

async function getPrice(symbol: string): Promise<number> {
  const s = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (STABLE_SYMBOLS.has(s)) return 1;
  // PT tokens (Pendle) — complex pricing, skip
  if (s.startsWith('PT')) return 0;
  const id = CG_IDS[s];
  if (!id) return 0;
  const cached = _priceCache[id];
  if (cached && Date.now() - cached.ts < 60_000) return cached.price;
  try {
    const r = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
    ).then(res => res.json()) as Record<string, { usd?: number }>;
    const price = r[id]?.usd ?? 0;
    _priceCache[id] = { price, ts: Date.now() };
    return price;
  } catch { return cached?.price ?? 0; }
}

// ── GET handler ───────────────────────────────────────────────────────────────

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = searchParams.get('account');
  if (!account) return NextResponse.json({ error: 'account required' }, { status: 400 });

  try {
    // Step 1: quick existence check
    const acctHex = await ethCall(POOL, SEL_USER_ACCOUNT + padAddr(account));
    const totalCollateral = word(acctHex, 0);
    const totalDebt       = word(acctHex, 1);

    if (totalCollateral === 0n && totalDebt === 0n) {
      return NextResponse.json({ supplies: [], borrows: [], protocol: 'HyperLend', chain: 'HyperEVM' });
    }
    console.log(`[hyperlend/route] ${account}: collateral=${totalCollateral} debt=${totalDebt}`);

    // Step 2: all reserve addresses
    const reserves = await getReservesList();
    console.log(`[hyperlend/route] ${reserves.length} reserves`);

    // Step 3: getUserReserveData for every reserve in parallel
    const userDataResults = await Promise.allSettled(
      reserves.map(async (asset) => {
        const hex = await ethCall(DATA_PROVIDER, SEL_USER_RESERVE + padAddr(asset) + padAddr(account));
        // Returns: [0]=currentATokenBalance [1]=currentStableDebt [2]=currentVariableDebt
        //          [3]=principalStableDebt [4]=scaledVariableDebt [5]=stableBorrowRate
        //          [6]=liquidityRate (supply APY in RAY) [7]=stableRateLastUpdated [8]=usageAsCollateral
        const currentATokenBalance = word(hex, 0);
        const currentVariableDebt  = word(hex, 2);
        const liquidityRate        = word(hex, 6); // supply APY in RAY (1e27=100%)
        return { asset, currentATokenBalance, currentVariableDebt, liquidityRate };
      }),
    );

    const active = userDataResults
      .filter((r): r is PromiseFulfilledResult<{
        asset: string; currentATokenBalance: bigint; currentVariableDebt: bigint; liquidityRate: bigint;
      }> => r.status === 'fulfilled')
      .map(r => r.value)
      .filter(p => p.currentATokenBalance > 0n || p.currentVariableDebt > 0n);

    if (active.length === 0) {
      return NextResponse.json({ supplies: [], borrows: [], protocol: 'HyperLend', chain: 'HyperEVM' });
    }

    // Step 4: metadata + borrow rates for active reserves in parallel
    const enriched = await Promise.allSettled(
      active.map(async (p) => {
        const [symbolHex, decimalsHex, reserveDataHex] = await Promise.all([
          ethCall(p.asset, SEL_SYMBOL),
          ethCall(p.asset, SEL_DECIMALS),
          ethCall(DATA_PROVIDER, SEL_RESERVE_DATA + padAddr(p.asset)),
        ]);
        const symbol   = decodeString(symbolHex);
        const decimals = Number(word(decimalsHex, 0));
        // getReserveData: [0]=unbacked [1]=accruedToTreasury [2]=totalAToken [3]=totalStableDebt
        //                 [4]=totalVariableDebt [5]=liquidityRate [6]=variableBorrowRate ...
        const variableBorrowRate = word(reserveDataHex, 6); // borrow APY in RAY
        return { ...p, symbol, decimals, variableBorrowRate };
      }),
    );

    // Step 5: build response
    const supplies: Array<{ symbol: string; amount: number; usdValue: number; apy: number | null }> = [];
    const borrows:  Array<{ symbol: string; amount: number; usdValue: number; apy: number | null }> = [];
    const RAY = 1e27;

    for (const r of enriched) {
      if (r.status !== 'fulfilled') continue;
      const { asset, currentATokenBalance, currentVariableDebt, liquidityRate, variableBorrowRate, symbol, decimals } = r.value;
      if (!symbol) {
        console.warn(`[hyperlend/route] No symbol for ${asset}`);
        continue;
      }
      const price = await getPrice(symbol);
      const scale = Math.pow(10, decimals);

      if (currentATokenBalance > 0n) {
        const amount = Number(currentATokenBalance) / scale;
        if (amount < 1e-9) continue;
        const usdValue = amount * price;
        const apy = Number(liquidityRate) / RAY * 100;
        console.log(`[hyperlend/route] Supply: ${symbol} amount=${amount.toFixed(6)} usd=$${usdValue.toFixed(2)} apy=${apy.toFixed(2)}%`);
        supplies.push({ symbol, amount, usdValue, apy });
      }

      if (currentVariableDebt > 0n) {
        const amount = Number(currentVariableDebt) / scale;
        if (amount < 1e-9) continue;
        const usdValue = amount * price;
        const apy = Number(variableBorrowRate) / RAY * 100;
        console.log(`[hyperlend/route] Borrow: ${symbol} amount=${amount.toFixed(6)} usd=$${usdValue.toFixed(2)} apy=${apy.toFixed(2)}%`);
        borrows.push({ symbol, amount, usdValue, apy });
      }
    }

    console.log(`[hyperlend/route] Final: ${supplies.length} supplies, ${borrows.length} borrows`);
    return NextResponse.json({ supplies, borrows, protocol: 'HyperLend', chain: 'HyperEVM' });
  } catch (err) {
    console.error('[hyperlend/route] Unexpected error:', err);
    return NextResponse.json({ supplies: [], borrows: [], error: String(err) });
  }
}
