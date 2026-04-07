// Shared snapshot logic used by both /api/cron/snapshot (authed cron) and
// /api/snapshot/manual (browser-triggered "Take Snapshot" button).

import { sql } from "./db";
import type { AerodromePosition } from "./aerodrome";

export type WalletRow = { address: string; chain: string };

const EVM_ROUTES = ["aerodrome", "uniswap/v3", "velodrome", "hyperswap", "pancakeswap"];
const SOL_ROUTES = ["raydium", "orca"];
const SUI_ROUTES = ["cetus", "bluefin", "momentum"];

export function baseUrlFromHeaders(headers: Headers): string {
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  const proto = headers.get("x-forwarded-proto") ?? "https";
  if (host) return `${proto}://${host}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

async function fetchPositions(base: string, route: string, account: string): Promise<AerodromePosition[]> {
  try {
    const r = await fetch(`${base}/api/${route}?account=${account}`, { cache: "no-store" });
    if (!r.ok) return [];
    const data = await r.json();
    return data.positions || [];
  } catch (e) {
    console.error(`[snapshot] fetch ${route} for ${account} failed:`, e);
    return [];
  }
}

export async function snapshotWallet(
  base: string,
  wallet: WalletRow,
): Promise<{ ok: boolean; positionCount: number; totalValue: number }> {
  const routes =
    wallet.chain === "evm" ? EVM_ROUTES :
    wallet.chain === "solana" ? SOL_ROUTES :
    wallet.chain === "sui" ? SUI_ROUTES : [];

  if (routes.length === 0) return { ok: false, positionCount: 0, totalValue: 0 };

  const results = await Promise.all(routes.map((r) => fetchPositions(base, r, wallet.address)));
  const positions: AerodromePosition[] = results.flat();

  const lpValue = positions.reduce((s, p) => s + (p.value || 0), 0);
  const totalFees = positions.reduce((s, p) => s + (p.fees || 0), 0);
  const totalValue = lpValue;

  await sql`
    INSERT INTO portfolio_snapshots
      (wallet_address, total_value, lp_value, lending_value, token_value, total_fees_earned, position_count)
    VALUES
      (${wallet.address}, ${totalValue}, ${lpValue}, 0, 0, ${totalFees}, ${positions.length})
  `;

  for (const p of positions) {
    await sql`
      INSERT INTO position_snapshots
        (wallet_address, position_id, protocol, chain, token_pair, value, uncollected_fees, claimed_fees, status)
      VALUES
        (${wallet.address}, ${p.id}, ${p.protocol}, ${p.chain}, ${p.pair}, ${p.value || 0}, ${p.fees || 0}, 0, ${p.status})
    `;
  }

  // Make sure the wallet exists in the wallets table even if /register was
  // never called (e.g. user clicked Take Snapshot before reconnecting).
  await sql`
    INSERT INTO wallets (address, chain)
    VALUES (${wallet.address}, ${wallet.chain})
    ON CONFLICT (address) DO UPDATE SET last_seen = NOW()
  `;

  return { ok: true, positionCount: positions.length, totalValue };
}
