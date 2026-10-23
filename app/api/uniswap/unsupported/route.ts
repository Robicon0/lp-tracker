import { NextRequest, NextResponse } from 'next/server';
import { evmRpcBatch } from '@/app/lib/evmRpc';
import { alchemyKey } from '@/app/lib/alchemyKey';
import {
  unsupportedPositionsNotice,
  unsupportedUncheckedNotice,
  type RouteTruncation,
} from '@/app/lib/enumerationTruncation';

// Counts the Uniswap position NFTs a wallet holds where DefiDesh cannot read
// positions yet: the V4 PositionManager on every chain, and the V3 position
// manager on chains /api/uniswap/v3 does not scan. One `balanceOf` per manager
// (26 CU on Alchemy). A count above zero becomes a notice; zero says nothing; a
// read that did not answer becomes an "unchecked" notice, never a clean zero
// (Methodology rule (e)).
//
// Addresses: Uniswap's deployment pages (docs.uniswap.org/contracts/v4/deployments,
// v3/reference/deployments). Each answered `name()` on chain, 2026-10-22.

interface ChainSpec {
  label: string;
  /** Alchemy host, when the network is enabled for this app; else `rpc`. */
  alchemyHost?: string;
  rpc?: string;
  v4?: string;
  /** V3 position manager, only on chains the V3 route does NOT scan. */
  v3?: string;
}

const CHAINS: Record<string, ChainSpec> = {
  ethereum:   { label: 'Ethereum',    alchemyHost: 'eth-mainnet',      v4: '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e' },
  base:       { label: 'Base',        alchemyHost: 'base-mainnet',     v4: '0x7c5f5a4bbd8fd63184577525326123b519429bdc' },
  arbitrum:   { label: 'Arbitrum',    alchemyHost: 'arb-mainnet',      v4: '0xd88f38f930b7952f2db2432cb002e7abbf3dd869' },
  optimism:   { label: 'Optimism',    alchemyHost: 'opt-mainnet',      v4: '0x3c3ea4b57a46241e54610e5f022e5c45859a1017' },
  polygon:    { label: 'Polygon',     alchemyHost: 'polygon-mainnet',  v4: '0x1ec2ebf4f37e7363fdfe3551602425af0b3ceef9' },
  bnb:        { label: 'BNB',         alchemyHost: 'bnb-mainnet',      v4: '0x7a4a5c919ae2541aed11041a1aeee68f1287f95b' },
  unichain:   { label: 'Unichain',    alchemyHost: 'unichain-mainnet', v4: '0x4529a01c7a0410167c5740c487a8de60232617bf', v3: '0x943e6e07a7e8e791dafc44083e54041d743c46e9' },
  avalanche:  { label: 'Avalanche',   rpc: 'https://api.avax.network/ext/bc/C/rpc',            v4: '0xb74b1f14d2754acfcbbe1a221023a5cf50ab8acd', v3: '0x655c406ebfa14ee2006250925e54ec43ad184f8b' },
  blast:      { label: 'Blast',       rpc: 'https://rpc.blast.io',                             v4: '0x4ad2f4cca2682cbb5b950d660dd458a1d3f1baad', v3: '0xb218e4f7cf0533d4696fdfc419a0023d33345f28' },
  worldchain: { label: 'World Chain', rpc: 'https://worldchain-mainnet.g.alchemy.com/public', v4: '0xc585e0f504613b5fbf874f21af14c65260fb41fa', v3: '0xec12a9f9a09f50550686363766cc153d03c27b5e' },
  zora:       { label: 'Zora',        rpc: 'https://rpc.zora.energy',                                                                         v3: '0xbc91e8dfa3ff18de43853372a3d7dfe585137d78' },
  celo:       { label: 'Celo',        rpc: 'https://forno.celo.org',                                                                          v3: '0x3d79edaabc0eab6f08ed885c05fc0b014290d95a' },
};

const BALANCE_OF = '0x70a08231';
const TIMEOUT_MS = 8_000;
const MEMO_MS = 5 * 60_000;

interface CountResult { version: 'V3' | 'V4'; chain: string; count: number | null }

const memo = new Map<string, { at: number; body: unknown }>();
const inFlight = new Map<string, Promise<unknown>>();

function rpcFor(spec: ChainSpec): string | null {
  if (spec.alchemyHost) {
    const key = alchemyKey();
    return key ? `https://${spec.alchemyHost}.g.alchemy.com/v2/${key}` : null;
  }
  return spec.rpc ?? null;
}

async function countChain(key: string, spec: ChainSpec, owner: string): Promise<CountResult[]> {
  const managers: Array<{ version: 'V3' | 'V4'; address: string }> = [];
  if (spec.v4) managers.push({ version: 'V4', address: spec.v4 });
  if (spec.v3) managers.push({ version: 'V3', address: spec.v3 });
  const failed = (): CountResult[] => managers.map((m) => ({ version: m.version, chain: spec.label, count: null }));
  const rpc = rpcFor(spec);
  if (!rpc) return failed();
  const data = BALANCE_OF + owner.slice(2).toLowerCase().padStart(64, '0');
  const calls = managers.map((m) => ({ method: 'eth_call', params: [{ to: m.address, data }, 'latest'] }));
  // One retry: a public endpoint's single dropped answer must not raise a notice.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const envs = await evmRpcBatch(rpc, calls, { timeoutMs: TIMEOUT_MS });
      const out = managers.map((m, i): CountResult => {
        const r = envs[i]?.result;
        const ok = typeof r === 'string' && /^0x[0-9a-f]{1,64}$/i.test(r);
        return { version: m.version, chain: spec.label, count: ok ? Number(BigInt(r as string)) : null };
      });
      if (out.every((o) => o.count != null) || attempt === 1) {
        if (out.some((o) => o.count == null)) console.warn(`[uniswap/unsupported] ${key}: count read failed`);
        return out;
      }
    } catch (err) {
      if (attempt === 1) {
        console.warn(`[uniswap/unsupported] ${key}: count read failed:`, err instanceof Error ? err.message : err);
        return failed();
      }
    }
  }
  return failed();
}

async function compute(owner: string) {
  const per = await Promise.all(Object.entries(CHAINS).map(([k, s]) => countChain(k, s, owner)));
  const counts = per.flat();
  const truncated: RouteTruncation[] = [];
  for (const c of counts) {
    const scope = `${c.version} / ${c.chain}`;
    if (c.count == null) truncated.push(unsupportedUncheckedNotice(scope));
    else if (c.count > 0) truncated.push(unsupportedPositionsNotice(scope, c.count));
  }
  return { account: owner, counts, truncated };
}

export async function GET(req: NextRequest) {
  const account = req.nextUrl.searchParams.get('account') ?? '';
  if (!/^0x[0-9a-fA-F]{40}$/.test(account)) {
    return NextResponse.json({ error: 'account must be an EVM address' }, { status: 400 });
  }
  const owner = account.toLowerCase();
  const hit = memo.get(owner);
  if (hit && Date.now() - hit.at < MEMO_MS) return NextResponse.json(hit.body);

  let p = inFlight.get(owner);
  if (!p) {
    p = compute(owner).finally(() => inFlight.delete(owner));
    inFlight.set(owner, p);
  }
  const body = (await p) as Awaited<ReturnType<typeof compute>>;
  // Only a fully answered count is remembered; an unchecked one is asked again.
  if (body.counts.every((c) => c.count != null)) memo.set(owner, { at: Date.now(), body });
  return NextResponse.json(body);
}
