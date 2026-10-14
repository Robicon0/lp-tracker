// Standing rule (k): a position the wallet never held is never part of its totals.
//
// Why: a wallet that deposits into a vault (a contract that runs its own CLMM
// positions) sends a transaction in which the vault's position emits liquidity
// and fee events. Sui wallet 0x9d6e…b1f9 read Capital G/L +1,055,757 from three
// such positions: the engine completed each one from the position OBJECT's
// history, which is every depositor's liquidity, and booked it to the wallet.
//
// The test is ownership, never a ratio (one of the three had withdrawn / deposited
// = 1.10). A position is NOT the wallet's only when all of these hold:
//   - the transaction that created it was sent by another address,
//   - no transaction that touched it was sent by the wallet,
//   - no version of it was ever owned by the wallet.
// A position the wallet opened (and later moved into a vault or wrapper), or
// received by transfer, or ever held, stays the wallet's. A read that fails is
// "unknown", never "not held".

export interface OwnershipFacts {
  creatorSender: string | null;
  creationEventTypes: string[];
  senders: string[];
  addressOwners: string[];
}

export type OwnershipVerdict =
  | { held: true }
  | { held: false; creator: string; vaultPackage: string | null };

/** A Sui address in one form for comparison: lowercase, 64 hex digits. */
export function normalizeSuiAddress(a: string): string {
  const hex = a.toLowerCase().replace(/^0x/, '');
  return `0x${hex.padStart(64, '0')}`;
}

// Event types that never name the vault: the CLMM protocols themselves, the
// framework, and price-oracle plumbing a vault's rebalance carries.
const NOT_A_VAULT = /pyth|price_?feed|price_?info|wormhole|::vaa::|oracle/i;
const FRAMEWORK = new Set(['0x1', '0x2', '0x3'].map(normalizeSuiAddress));

export function ownershipVerdict(f: OwnershipFacts, wallet: string, clmmPackages: readonly string[]): OwnershipVerdict {
  const w = normalizeSuiAddress(wallet);
  const same = (a: string | null | undefined) => !!a && normalizeSuiAddress(a) === w;
  // No creation transaction found: nothing proves it is someone else's.
  if (!f.creatorSender) return { held: true };
  if (same(f.creatorSender)) return { held: true };
  if (f.senders.some(same)) return { held: true };
  if (f.addressOwners.some(same)) return { held: true };
  const clmm = new Set(clmmPackages.map(normalizeSuiAddress));
  let vaultPackage: string | null = null;
  for (const t of f.creationEventTypes) {
    const pkg = normalizeSuiAddress(t.split('::')[0] ?? '');
    if (clmm.has(pkg) || FRAMEWORK.has(pkg) || NOT_A_VAULT.test(t)) continue;
    vaultPackage = pkg;
    break;
  }
  return { held: false, creator: normalizeSuiAddress(f.creatorSender), vaultPackage };
}

/** "0xc4ebf3…1d05" — the short form used in row notes. */
export function shortAddress(a: string): string {
  return a.length > 14 ? `${a.slice(0, 10)}…${a.slice(-4)}` : a;
}

/** The note on a row that is not the wallet's position. */
export function notHeldNote(n: { vaultPackage: string | null; creator: string }): string {
  return n.vaultPackage
    ? `held by a vault (package ${shortAddress(n.vaultPackage)}) - not this wallet's position`
    : `opened and held by another address (${shortAddress(n.creator)}) - not this wallet's position`;
}
