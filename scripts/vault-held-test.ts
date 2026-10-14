// Standing rule (k): a position the wallet never held is never part of its
// totals; a closed position whose numbers look impossible is "check history".
//   npx tsx scripts/vault-held-test.ts          (pure cases)
//   LIVE=1 npx tsx scripts/vault-held-test.ts   (also reads the chain, read-only)
import { ownershipVerdict, notHeldNote, type OwnershipFacts } from '../app/lib/positionOwnership';
import { classifyReconstructedClosed, impossibleClosedReason } from '../app/lib/closedPositionClassify';
import { notHeldOpenNotice, isInfoReason, hasLookupFailure, describeTruncation } from '../app/lib/enumerationTruncation';
import type { ActivityEventForPnL } from '../app/lib/positionPnl';

export {};
let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const WALLET = '0x9d6ea1972a50e987182bc937f1ea5fca1c1e3e4190ae36751cf273d01a13b1f9';
const OPERATOR = '0x23e00f54aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaf19';
const CLMM = [
  '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb',
  '0xdb5cd62a06c79695bfc9982eb08534706d3752fe123b48e0144f480209b3117f',
];
const VAULT_PKG = '0xc4ebf35b0000000000000000000000000000000000000000000000000000001d05';
const vaultCreation = [
  `${CLMM[0]}::pool::OpenPositionEvent`,
  `${VAULT_PKG}::pool::RebalanceEvent`,
  '0x8d97f1cd0000000000000000000000000000000000000000000000000000beef::event::PriceFeedUpdateEvent',
  `${VAULT_PKG}::pyth_oracle::PriceUpdated`,
];
const facts = (f: Partial<OwnershipFacts>): OwnershipFacts => ({ creatorSender: OPERATOR, creationEventTypes: vaultCreation, senders: [OPERATOR], addressOwners: [], ...f });

console.log('1. forced vault case');
{
  const v = ownershipVerdict(facts({}), WALLET, CLMM);
  check('not held', !v.held);
  if (!v.held) {
    check('names the vault package (not the CLMM, not the price oracle)', v.vaultPackage === VAULT_PKG, String(v.vaultPackage));
    check('note names the package', /held by a vault \(package 0xc4ebf35b…1d05\) - not this wallet's position/.test(notHeldNote(v)), notHeldNote(v));
  }
  const noVault = ownershipVerdict(facts({ creationEventTypes: [`${CLMM[0]}::pool::OpenPositionEvent`] }), WALLET, CLMM);
  check('another address with no vault events: still not held, says who', !noVault.held && noVault.vaultPackage === null && /opened and held by another address/.test(notHeldNote(noVault)));
  // The row: in no total, fee claims included.
  const ev = (type: ActivityEventForPnL['type'], a0: number, a1: number, usd: number): ActivityEventForPnL => ({ type, timestamp: 1, amount0: a0, amount1: a1, usdAtTime: usd, price0AtTime: null, price1AtTime: null });
  const row = classifyReconstructedClosed({ events: [ev('deposit', 15.13, 0.9, 13.36), ev('withdrawal', 4_032_413, 100, 640_359.28), ev('fee_claim', 1, 1, 3.44)], notHeldNote: notHeldNote(v as never) });
  check('classified as a not-held row, not priced into any total', row.kind === 'not-held');
  if (row.kind === 'not-held') check('row keeps its amounts and the priced part for display', row.detail.withdrawalAmount0 === 4_032_413 && row.detail.pricedFeesUSD === 3.44);
  // A vault position that is still open is not a closed position: no row, a
  // counted information notice that marks no total.
  const n = notHeldOpenNotice('closed-position history', 2);
  check('open vault positions: counted information notice, no `≈`', isInfoReason(n.reason) && !hasLookupFailure([n]) && /2 open positions named in this wallet's history are held by a vault/.test(describeTruncation({ ...n, source: 'Sui', address: '0x0' })));
}

console.log('2. transferred-in case (another address opened it, the wallet held it)');
{
  check('a version owned by the wallet → held', ownershipVerdict(facts({ addressOwners: [OPERATOR, WALLET] }), WALLET, CLMM).held);
  check('the same address written short / upper case still matches', ownershipVerdict(facts({ addressOwners: ['0x' + WALLET.slice(2).toUpperCase()] }), WALLET, CLMM).held);
  check('the wallet sent a transaction on it → held', ownershipVerdict(facts({ senders: [OPERATOR, WALLET] }), WALLET, CLMM).held);
}

console.log('3. moved-into-vault case (the wallet opened it, then a vault holds it)');
{
  // Chain shape of 0x29af7d0e on this wallet: created by the wallet and wrapped
  // into a vault in the same transaction, so no version has an address owner.
  check('created by the wallet, never address-owned → held', ownershipVerdict(facts({ creatorSender: WALLET, senders: [WALLET], addressOwners: [] }), WALLET, CLMM).held);
  check('created by the wallet, later only operators act on it → held', ownershipVerdict(facts({ creatorSender: WALLET, senders: [WALLET, OPERATOR] }), WALLET, CLMM).held);
  check('no creation transaction found → never flagged', ownershipVerdict(facts({ creatorSender: null }), WALLET, CLMM).held);
}

console.log('4. sanity guard (backstop)');
{
  check('3.5x and over $1,000 → check history', impossibleClosedReason(1_000, 3_500) === 'withdrawn 3.5x what was deposited');
  check('2.9x and over $1,000 → a result', impossibleClosedReason(10_000, 29_000) === null);
  check('exactly 3x → a result', impossibleClosedReason(1_000, 3_000) === null);
  check('10x but below $1,000 → a result', impossibleClosedReason(90, 900) === null);
  check('withdrawals with deposits worth nothing → check history', impossibleClosedReason(0, 5) === 'withdrawals with no deposit value');
  check('nothing withdrawn → a result', impossibleClosedReason(0, 0) === null && impossibleClosedReason(500, 0) === null);
  const ev = (type: ActivityEventForPnL['type'], usd: number): ActivityEventForPnL => ({ type, timestamp: 1, amount0: 1, amount1: 1, usdAtTime: usd, price0AtTime: 1, price1AtTime: 1 });
  const big = classifyReconstructedClosed({ events: [ev('deposit', 2_011.06), ev('withdrawal', 376_002.83)] });
  check('classifier: a 187x position is a check-history row', big.kind === 'check-history' && big.detail.why === 'withdrawn 187.0x what was deposited', JSON.stringify(big).slice(0, 120));
  const ok = classifyReconstructedClosed({ events: [ev('deposit', 478_896.44), ev('withdrawal', 525_105.02)] });
  check('classifier: a 1.10x position stays priced (why ownership is the real test)', ok.kind === 'priced');
}

async function live() {
  console.log('5. live chain (read-only)');
  const { getSuiObjectOwnership } = await import('../app/lib/suiHistory');
  const ids: Array<[string, boolean, string]> = [
    ['0x76c215ccba5b346bc4b1e16481f09e87d2d2fa7b7749a5230fea1ad1822f644d', false, 'vault DEEP / SUI'],
    ['0xed741330d515a8e578756b5397963a3594e5262b91710ea33b8bdc9a6ad34794', true, 'opened and held by the wallet'],
    ['0x29af7d0e40d1c16908aac62ab700021e7dd6dcd23d16c235b799fe7e4fe68789', true, 'opened by the wallet straight into a vault'],
  ];
  for (const [id, held, label] of ids) {
    const v = ownershipVerdict(await getSuiObjectOwnership(id), WALLET, [...CLMM, '0xdc67d6de3f00051c505da10d8f6fbab3b3ec21ec65f0dc22a2f36c13fc102110']);
    check(`${label} (${id.slice(0, 10)}): ${held ? 'held' : 'not held'}`, v.held === held, JSON.stringify(v));
    if (!v.held) check('  package is 0xc4ebf35b…1d05', /^0xc4ebf35b.*1d05$/.test(v.vaultPackage ?? ''), String(v.vaultPackage));
  }
}

(async () => {
  if (process.env.LIVE === '1') await live();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
