import { NextResponse } from 'next/server';

// HypurrFi (HyperEVM) — Aave V3 fork with multi-asset collateral pools
// (HYPE, stHYPE, USDC, USDXL stablecoin). Same selectors as Aave V3 / the
// existing HyperLend route — only the contract addresses differ.
//
// The Pool / ProtocolDataProvider addresses for HypurrFi are not yet
// publicly documented at the time of writing. They are read from env
// vars HYPURRFI_POOL and HYPURRFI_DATA_PROVIDER so the integration can
// be activated in Vercel without redeploying code. Until those are set
// the route returns an empty position list — matching the rule "never
// show if the wallet has no position on that protocol".
//
// When the addresses are populated, the route iterates a configurable
// list of HyperEVM reserves (HYPE / stHYPE / wHYPE / USDC / USDT0 /
// USDXL / USDe / sUSDe), calls getUserReserveData(asset, user) and
// getReserveData(asset) on the data provider, decodes RAY-encoded rates
// and amounts, and returns the standard supplies/borrows shape.

const HYPEREVM_RPC = process.env.HYPEREVM_RPC ?? 'https://rpc.hyperliquid.xyz/evm';
const POOL = (process.env.HYPURRFI_POOL ?? '').toLowerCase();
const DATA_PROVIDER = (process.env.HYPURRFI_DATA_PROVIDER ?? '').toLowerCase();

// Reserve registry — extended freely without code changes via env override
// HYPURRFI_RESERVES=symbol:address,symbol:address,...
const DEFAULT_RESERVES: Record<string, string> = {
  WHYPE:  '0xadcb2f358eae6492f61a5f87eb8893d09391d160',
  USDC:   '0xb88339cb7199b77e23db6e890353e22632ba630f',
  USDT0:  '0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb',
  USDe:   '0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34',
  sUSDe:  '0x1d7ca62f6af49ec66f6680b8606e634e55ef22c1',
  USDHL:  '0x9ab96a4668456896d45c301bc3a15cee76aa7b8d',
};
const RESERVES: Record<string, string> = (() => {
  const overrides = process.env.HYPURRFI_RESERVES;
  if (!overrides) return DEFAULT_RESERVES;
  const out: Record<string, string> = { ...DEFAULT_RESERVES };
  for (const piece of overrides.split(',')) {
    const [sym, addr] = piece.split(':').map((s) => s.trim());
    if (sym && addr) out[sym.toUpperCase()] = addr.toLowerCase();
  }
  return out;
})();

// Aave V3 selectors — identical to HyperLend route.
const SEL_USER_RESERVE = '0x28dd2d01';
const SEL_RESERVE_DATA = '0x35ea6a75';

// Heuristic price map — stables = $1, native HYPE / wHYPE follow CoinGecko id
// "hyperliquid" but we keep it simple with a static fallback for SSR
// reliability. Real-time pricing happens upstream via /api/prices when
// the lending UI joins this with token data.
const PRICE_FALLBACK: Record<string, number> = {
  USDC: 1, USDT0: 1, USDe: 1, sUSDe: 1, USDHL: 1, USDXL: 1, DAI: 1,
  WHYPE: 0, HYPE: 0, // upstream resolves real prices
};

function pad32(addr: string): string {
  return addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

async function ethCall(to: string, data: string): Promise<string | null> {
  try {
    const res = await fetch(HYPEREVM_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to, data }, 'latest'],
      }),
    });
    const j = await res.json();
    if (j.error) return null;
    return j.result as string;
  } catch (err) {
    console.error('[hypurrfi/route] eth_call threw:', err);
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

// Convert RAY (1e27) per-second-style rate to APY %.
// Aave V3 returns liquidity / borrow rates in RAY format already
// expressed as "per year": rate / 1e27 * 100 = APY %.
function rayToApy(ray: bigint): number {
  return Number(ray) / 1e27 * 100;
}

interface UserReserveData {
  scaledATokenBalance: bigint; // word 0
  // word 1-3: stable / variable debt
  currentVariableDebt: bigint; // word 2
  // we read more but only use these
  liquidityRate: bigint; // word 6 in user-reserve encoding (Aave V3)
  variableBorrowRate?: bigint;
}

async function getUserReserveData(asset: string, user: string): Promise<UserReserveData | null> {
  const data = SEL_USER_RESERVE + pad32(asset) + pad32(user);
  const res = await ethCall(DATA_PROVIDER, data);
  if (!res || res === '0x' || res.length < 130) return null;
  // Aave V3 getUserReserveData layout (returns ~9 words):
  //  [0] currentATokenBalance, [1] currentStableDebt,
  //  [2] currentVariableDebt, [3] principalStableDebt,
  //  [4] scaledVariableDebt,  [5] stableBorrowRate,
  //  [6] liquidityRate,       [7] stableRateLastUpdated,
  //  [8] usageAsCollateralEnabled
  return {
    scaledATokenBalance: decodeWord(res, 0),
    currentVariableDebt: decodeWord(res, 2),
    liquidityRate: decodeWord(res, 6),
  };
}

async function getReserveBorrowApy(asset: string): Promise<number> {
  const res = await ethCall(DATA_PROVIDER, SEL_RESERVE_DATA + pad32(asset));
  if (!res || res === '0x' || res.length < 130) return 0;
  // Aave V3 reserve data: word 6 = variableBorrowRate (RAY).
  return rayToApy(decodeWord(res, 6));
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = searchParams.get('account');
  if (!account) return NextResponse.json({ error: 'account required' }, { status: 400 });

  if (!POOL || !DATA_PROVIDER) {
    // Not configured yet — return empty so the protocol is silently absent
    // from the lending page (per spec: never show if wallet has no position).
    return NextResponse.json({
      supplies: [], borrows: [], protocol: 'HypurrFi', chain: 'HyperEVM',
      note: 'HYPURRFI_POOL / HYPURRFI_DATA_PROVIDER env vars not configured',
    });
  }

  const supplies: Array<{ symbol: string; amount: number; usdValue: number; apy: number }> = [];
  const borrows: Array<{ symbol: string; amount: number; usdValue: number; apy: number }> = [];

  // Token decimals — best-effort from a small static map. New reserves can
  // override via HYPURRFI_DECIMALS=symbol:decimals,...
  const DECIMALS: Record<string, number> = {
    WHYPE: 18, HYPE: 18, USDC: 6, USDT0: 6, USDe: 18, sUSDe: 18, USDHL: 6, USDXL: 18,
  };

  // Fan out one reserve fetch per token for the connected wallet.
  const tasks = Object.entries(RESERVES).map(async ([symbol, asset]) => {
    const data = await getUserReserveData(asset, account);
    if (!data) return;
    const decimals = DECIMALS[symbol] ?? 18;
    const supplyApy = rayToApy(data.liquidityRate);
    const supplyAmt = Number(data.scaledATokenBalance) / 10 ** decimals;
    const debtAmt = Number(data.currentVariableDebt) / 10 ** decimals;
    const price = PRICE_FALLBACK[symbol] ?? 0;

    if (supplyAmt > 0.000001) {
      supplies.push({
        symbol,
        amount: supplyAmt,
        usdValue: supplyAmt * price,
        apy: supplyApy,
      });
    }
    if (debtAmt > 0.000001) {
      const borrowApy = await getReserveBorrowApy(asset);
      borrows.push({
        symbol,
        amount: debtAmt,
        usdValue: debtAmt * price,
        apy: borrowApy,
      });
    }
  });
  await Promise.all(tasks);

  console.log(
    `[hypurrfi/route] ${account.slice(0, 8)}… → ${supplies.length} supplies, ${borrows.length} borrows`,
  );

  return NextResponse.json({
    supplies, borrows, protocol: 'HypurrFi', chain: 'HyperEVM',
  });
}
