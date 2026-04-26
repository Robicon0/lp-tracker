import { NextResponse } from 'next/server';

// HypurrFi (HyperEVM) — Aave V3 fork with multi-asset collateral pools
// (HYPE, stHYPE, USDC) plus its own overcollateralized USDXL stablecoin.
// Same selectors as Aave V3 / the existing HyperLend route — only the
// addresses and reserve registry differ.
//
// Addresses verified directly against HyperEVM RPC (eth_call):
//   Pool                  = 0xcecce0eb9dd2ef7996e01e25dd70e461f918a14b
//   PoolAddressesProvider = 0xa73ff12d177d8f1ec938c3ba0e87d33524dd5594
//                              (= Pool.getAddressesProvider())
//   ProtocolDataProvider  = 0x895c799a5bbdcb63b80bee5bd94e7b9138d977d6
//                              (= AddressesProvider.getPoolDataProvider())
// All three are hardcoded so the integration works on Vercel without env
// configuration. If HypurrFi migrates contracts, update these constants.

const HYPEREVM_RPC = 'https://rpc.hyperliquid.xyz/evm';
const POOL = '0xcecce0eb9dd2ef7996e01e25dd70e461f918a14b';
const ADDRESSES_PROVIDER = '0xa73ff12d177d8f1ec938c3ba0e87d33524dd5594';
const DATA_PROVIDER = '0x895c799a5bbdcb63b80bee5bd94e7b9138d977d6';

// Aave V3 selectors — identical to HyperLend route.
const SEL_USER_RESERVE = '0x28dd2d01';   // getUserReserveData(asset, user)
const SEL_RESERVE_DATA = '0x35ea6a75';   // getReserveData(asset)

// Reserve registry — extracted directly from the live data provider's
// getAllReservesTokens() return on HyperEVM (decoded once, hardcoded so
// every wallet query avoids the dynamic ABI tuple decode entirely).
// To refresh this list when HypurrFi adds reserves, run:
//   curl -s https://rpc.hyperliquid.xyz/evm -X POST -H "Content-Type:application/json" \
//     -d '{"jsonrpc":"2.0","id":1,"method":"eth_call",
//          "params":[{"to":"0x895c799a5bbdcb63b80bee5bd94e7b9138d977d6","data":"0xb316ff89"},"latest"]}'
// and decode the (string, address)[] tuple array.
const HYPURRFI_RESERVES: Array<{ symbol: string; addr: string }> = [
  { symbol: 'WHYPE',              addr: '0x5555555555555555555555555555555555555555' },
  { symbol: 'wstHYPE',            addr: '0x94e8396e0869c9f2200760af0621afd240e1cf38' },
  { symbol: 'USDXL',              addr: '0xca79db4b49f608ef54a5cb813fbed3a6387bc645' },
  { symbol: 'UBTC',               addr: '0x9fdbda0a5e284c32744d2f17ee5c74b284993463' },
  { symbol: 'UETH',               addr: '0xbe6727b535545c67d5caa73dea54865b92cf7907' },
  { symbol: 'USDe',               addr: '0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34' },
  { symbol: 'feUSD',              addr: '0x02c6a2fa58cc01a18b8d9e00ea48d65e4df26c70' },
  { symbol: 'USDT0',              addr: '0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb' },
  { symbol: 'USDHL',              addr: '0xb50a96253abdf803d85efcdce07ad8becbc52bd5' },
  { symbol: 'USOL',               addr: '0x068f321fa8fb9f0d135f290ef6a3e2813e1c8a29' },
  { symbol: 'kHYPE',              addr: '0xfd739d4e423301ce9385c1fb8850539d657c296d' },
  { symbol: 'XAUt0',              addr: '0xf4d9235269a96aadafc9adae454a0618ebe37949' },
  { symbol: 'thBILL',             addr: '0xfdd22ce6d1f66bc0ec89b20bf16ccb6670f55a5a' },
  { symbol: 'sUSDe',              addr: '0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2' },
  { symbol: 'PT-kHYPE-13NOV2025', addr: '0x311db0fde558689550c68355783c95efdfe25329' },
  { symbol: 'beHYPE',             addr: '0xd8fc8f0b03eba61f64d08b0bef69d80916e5dda9' },
  { symbol: 'USDC',               addr: '0xb88339cb7199b77e23db6e890353e22632ba630f' },
  { symbol: 'USDH',               addr: '0x111111a1a0667d36bd57c0a9f569b98057111111' },
  { symbol: 'PT-kHYPE-19MAR2026', addr: '0xea84ca9849d9e76a78b91f221f84e9ca065fc9f5' },
];

// Token decimals — decoded on demand from `decimals()` per asset and cached
// so every wallet query needs at most one round-trip per new token.
const SEL_DECIMALS = '0x313ce567';
const decimalsCache = new Map<string, number>();

// Native HYPE alias used by HyperEVM pools.
const NATIVE_HYPE = '0x5555555555555555555555555555555555555555';

// USD price fallback. Stables anchor to $1; non-stables resolve to 0 here
// and the lending UI joins this with live token prices upstream where needed.
const PRICE_FALLBACK: Record<string, number> = {
  USDC: 1, USDT: 1, USDT0: 1, USDe: 1, sUSDe: 1, USDHL: 1, USDXL: 1, DAI: 1,
  WHYPE: 0, HYPE: 0, stHYPE: 0, wstHYPE: 0,
};

function pad32(addr: string): string {
  return addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

async function ethCall(to: string, data: string, label: string): Promise<string | null> {
  try {
    const res = await fetch(HYPEREVM_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
    });
    const j = await res.json();
    if (j.error) {
      console.error(`[hypurrfi/route] eth_call ${label} → error: ${JSON.stringify(j.error)}`);
      return null;
    }
    return j.result as string;
  } catch (err) {
    console.error(`[hypurrfi/route] eth_call ${label} threw:`, err);
    return null;
  }
}

function decodeWord(hex: string, idx: number): bigint {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const start = idx * 64;
  const w = h.slice(start, start + 64);
  if (w.length < 64) return 0n;
  return BigInt('0x' + w);
}

// Aave V3 returns rates in RAY format expressed as "per year" — divide by
// 1e27 then multiply by 100 to get APY %.
function rayToApy(ray: bigint): number {
  return (Number(ray) / 1e27) * 100;
}

async function getDecimals(asset: string, hint: string): Promise<number> {
  if (decimalsCache.has(asset)) return decimalsCache.get(asset)!;
  // Native HYPE has no decimals() — assume 18 like wHYPE.
  if (asset.toLowerCase() === NATIVE_HYPE) {
    decimalsCache.set(asset, 18);
    return 18;
  }
  const res = await ethCall(asset, SEL_DECIMALS, `decimals(${hint})`);
  const d = res ? Number(decodeWord(res, 0)) : 18;
  const safe = Number.isFinite(d) && d > 0 && d <= 36 ? d : 18;
  decimalsCache.set(asset, safe);
  return safe;
}

async function getUserReserveData(asset: string, user: string, hint: string): Promise<{ supplyAmt: bigint; debtAmt: bigint; supplyApy: number } | null> {
  const data = SEL_USER_RESERVE + pad32(asset) + pad32(user);
  const res = await ethCall(DATA_PROVIDER, data, `userReserveData(${hint})`);
  if (!res || res === '0x' || res.length < 130) return null;
  // Aave V3 getUserReserveData layout (9 words):
  //  [0] currentATokenBalance, [1] currentStableDebt, [2] currentVariableDebt,
  //  [3] principalStableDebt,  [4] scaledVariableDebt, [5] stableBorrowRate,
  //  [6] liquidityRate,        [7] stableRateLastUpdated, [8] usageAsCollateralEnabled
  return {
    supplyAmt: decodeWord(res, 0),
    debtAmt: decodeWord(res, 2),
    supplyApy: rayToApy(decodeWord(res, 6)),
  };
}

async function getReserveBorrowApy(asset: string, hint: string): Promise<number> {
  const res = await ethCall(DATA_PROVIDER, SEL_RESERVE_DATA + pad32(asset), `reserveData(${hint})`);
  if (!res || res === '0x' || res.length < 130) return 0;
  // word 6 = variableBorrowRate (RAY)
  return rayToApy(decodeWord(res, 6));
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = (searchParams.get('account') ?? '').trim();
  if (!account) return NextResponse.json({ error: 'account required' }, { status: 400 });
  if (!/^0x[a-fA-F0-9]{40}$/.test(account)) {
    return NextResponse.json({ error: 'invalid EVM address', supplies: [], borrows: [], protocol: 'HypurrFi', chain: 'HyperEVM' });
  }

  console.log(
    `[hypurrfi/route] BEGIN account="${account}" pool=${POOL} provider=${DATA_PROVIDER}`,
  );

  const reserves = HYPURRFI_RESERVES;
  console.log(`[hypurrfi/route] checking ${reserves.length} reserves: ${reserves.map(r => r.symbol).join(',')}`);

  const supplies: Array<{ symbol: string; amount: number; usdValue: number; apy: number }> = [];
  const borrows: Array<{ symbol: string; amount: number; usdValue: number; apy: number }> = [];

  // Fan out user reserve fetches. Decimals + borrow APY are resolved on-demand
  // and cached so subsequent wallets cost nothing extra.
  await Promise.all(reserves.map(async ({ symbol, addr }) => {
    const data = await getUserReserveData(addr, account, symbol);
    if (!data) return;
    const decimals = await getDecimals(addr, symbol);
    const supplyAmt = Number(data.supplyAmt) / 10 ** decimals;
    const debtAmt = Number(data.debtAmt) / 10 ** decimals;
    const price = PRICE_FALLBACK[symbol] ?? 0;

    if (supplyAmt > 0.000001) {
      console.log(`[hypurrfi/route]  + supply ${symbol} amount=${supplyAmt.toFixed(6)} apy=${data.supplyApy.toFixed(2)}%`);
      supplies.push({ symbol, amount: supplyAmt, usdValue: supplyAmt * price, apy: data.supplyApy });
    }
    if (debtAmt > 0.000001) {
      const borrowApy = await getReserveBorrowApy(addr, symbol);
      console.log(`[hypurrfi/route]  - borrow ${symbol} amount=${debtAmt.toFixed(6)} apy=${borrowApy.toFixed(2)}%`);
      borrows.push({ symbol, amount: debtAmt, usdValue: debtAmt * price, apy: borrowApy });
    }
  }));

  console.log(
    `[hypurrfi/route] DONE account="${account.slice(0, 8)}…" supplies=${supplies.length} borrows=${borrows.length}`,
  );

  return NextResponse.json({
    supplies, borrows, protocol: 'HypurrFi', chain: 'HyperEVM',
  });
}
