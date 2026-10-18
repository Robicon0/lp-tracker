// The ONE place server code reads the Alchemy key (batch C 2b).
//
// `ALCHEMY_KEY` (server-only, never in the browser bundle) wins; until it is set
// in Vercel the old `NEXT_PUBLIC_ALCHEMY_KEY` is used so this deploy cannot break
// production before the new key exists. Once the browser makes no Alchemy calls
// (app/api/evm/token-balances), the NEXT_PUBLIC_ variable can be removed.
// Server-only: never import this from a "use client" file.

export function alchemyKey(): string | undefined {
  return process.env.ALCHEMY_KEY || process.env.NEXT_PUBLIC_ALCHEMY_KEY || undefined;
}

const HOSTS: Record<string, string> = {
  ethereum: 'eth-mainnet', base: 'base-mainnet', arbitrum: 'arb-mainnet',
  optimism: 'opt-mainnet', polygon: 'polygon-mainnet', bnb: 'bnb-mainnet',
};

/** `https://{host}.g.alchemy.com/v2/{key}` for a chain, or null (unknown chain / no key). Never log it. */
export function alchemyUrl(chain: string): string | null {
  const key = alchemyKey();
  const host = HOSTS[chain.toLowerCase()];
  return key && host ? `https://${host}.g.alchemy.com/v2/${key}` : null;
}
