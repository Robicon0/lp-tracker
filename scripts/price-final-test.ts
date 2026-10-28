// priceFinal: which unpriced legs are final (never retried). No network.
// Run: npx tsx scripts/price-final-test.ts
import { legPriceFinal, eventPriceFinal, positionPricingFinal, isPlaceholderBurnedRow, hasNoStableAnchor } from '../app/lib/priceFinal';

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) passed += 1; else { failed += 1; console.log(`FAIL ${name} ${detail}`); }
}

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = '0x4200000000000000000000000000000000000006';
const UNKNOWN = '0x' + 'ab'.repeat(20); // any non-stable token
const STABLES = new Set([USDC]);
const base = { pool: '0xpool', stablecoins: STABLES, spotReadFailed: false };

// Route side.
check('no stable side → final', legPriceFinal({ ...base, token0: WETH, token1: UNKNOWN }));
check('two unknown tokens → final', legPriceFinal({ ...base, token0: UNKNOWN, token1: '0xabc' }));
check('stable side → not final (a missing block price is a failed archive read)', !legPriceFinal({ ...base, token0: UNKNOWN, token1: USDC }));
check('stable side, mixed case → not final', !legPriceFinal({ ...base, token0: UNKNOWN, token1: USDC.toUpperCase().replace('0X', '0x') }));
check('pool unknown → not final', !legPriceFinal({ ...base, pool: '', token0: WETH, token1: UNKNOWN }));
check('spot read failed → not final', !legPriceFinal({ ...base, spotReadFailed: true, token0: WETH, token1: UNKNOWN }));
check('token address missing → not final', !legPriceFinal({ ...base, token0: '', token1: UNKNOWN }));
check('hasNoStableAnchor', hasNoStableAnchor(WETH, UNKNOWN, STABLES) && !hasNoStableAnchor(USDC, UNKNOWN, STABLES));

check('null deposit marked', eventPriceFinal('deposit', null, undefined, true));
check('spot-substituted withdrawal marked', eventPriceFinal('withdrawal', 12, 'current-spot-substituted', true));
check('priced deposit not marked', !eventPriceFinal('deposit', 12, undefined, true));
check('fee claim never marked', !eventPriceFinal('fee_claim', null, undefined, true));
check('not final → not marked', !eventPriceFinal('deposit', null, undefined, false));

// Client side.
const dep = (usd: number | null, extra: Record<string, unknown> = {}) => ({ type: 'deposit', usdAtTime: usd, ...extra });
const wd = (usd: number | null, extra: Record<string, unknown> = {}) => ({ type: 'withdrawal', usdAtTime: usd, ...extra });
check('all unpriced legs final → final', positionPricingFinal([dep(null, { priceFinal: true }), wd(null, { priceFinal: true })]));
check('spot legs final → final', positionPricingFinal([dep(5, { priceBasis: 'current-spot-substituted', priceFinal: true }), wd(4, { priceBasis: 'current-spot-substituted', priceFinal: true })]));
check('one leg not final → not final', !positionPricingFinal([dep(null, { priceFinal: true }), wd(null)]));
check('fully priced → not final', !positionPricingFinal([dep(5), wd(4), { type: 'fee_claim', usdAtTime: null }]));
check('unpriced fee claim does not count', !positionPricingFinal([{ type: 'fee_claim', usdAtTime: null, priceFinal: true }]));
check('no events → not final', !positionPricingFinal([]));
check('old cached events (no marker) → not final', !positionPricingFinal([dep(null), wd(null)]));

const burned = { protocol: 'Uniswap V3', status: 'Closed', token0Symbol: 'TOKEN0', token1Symbol: 'TOKEN1' };
check('placeholder burned row', isPlaceholderBurnedRow(burned));
check('real closed Uniswap row', !isPlaceholderBurnedRow({ ...burned, token0Address: WETH, token1Address: USDC, token0Symbol: 'WETH', token1Symbol: 'USDC' }));
check('open row', !isPlaceholderBurnedRow({ ...burned, status: 'In Range' }));
check('Aerodrome TOKEN0 row is not a placeholder row', !isPlaceholderBurnedRow({ ...burned, protocol: 'Aerodrome', token0Address: UNKNOWN, token1Address: WETH }));

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
