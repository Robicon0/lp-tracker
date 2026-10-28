// lib/format.ts: with "Hide numbers" OFF every shared formatter returns exactly
// what the per-file copies it replaced returned; ON, amounts and quantities are
// the mask and prices are not. No network, no storage (no window in Node).
// Run: npx tsx scripts/clp-format-test.ts
import {
  MASK, formatUsd, formatUsdExact, formatSignedUsd, formatUsdRaw, formatUsdPrice,
  formatToken, formatTokenCount, formatTokenUnguarded, hideAmount,
  maskAmountsInText, maskNumbersInText, setPrivacyMode, isPrivacyMode,
} from '../app/clp-tracker/lib/format';
import { formatPrice } from '../app/clp-tracker/lib/positionFormUtils';

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) passed += 1; else { failed += 1; console.log(`FAIL ${name} ${detail}`); }
}

// The old definitions, copied from HEAD before the change (every file used one
// of these shapes; see the commit for the list).
const oldUsdF = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const oldPriceF = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 });
const oldTokenF = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const oldTokenCountF = new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 6 });
const old = {
  formatUsd: (v: number) => oldUsdF.format(Number.isFinite(v) ? v : 0),
  formatSignedUsd: (v: number) => (v > 0 ? `+${old.formatUsd(v)}` : old.formatUsd(v)),
  formatUsdRaw: (v: number) => oldUsdF.format(v),
  formatUsdPrice: (v: number) => oldPriceF.format(Number.isFinite(v) ? v : 0),
  formatToken: (v: number) => oldTokenF.format(Number.isFinite(v) ? v : 0),
  formatTokenCount: (v: number) => oldTokenCountF.format(Number.isFinite(v) ? v : 0),
  fmtTokenAmount: (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 }),
};

const samples = [
  0, -0, 1, -1, 0.004, 0.005, 0.0049999, 0.1234567, 12.345678901, 1234.5, -1234.567,
  999999.999, 1e9, -1e9, 1e-7, 3717.2997, 5741.232488, 0.00000123,
  NaN, Infinity, -Infinity,
];

setPrivacyMode(false);
check('starts off', isPrivacyMode() === false);
for (const v of samples) {
  check(`formatUsd ${v}`, formatUsd(v) === old.formatUsd(v), `${formatUsd(v)} vs ${old.formatUsd(v)}`);
  check(`formatUsdExact ${v}`, formatUsdExact(v) === old.formatUsd(v));
  check(`formatSignedUsd ${v}`, formatSignedUsd(v) === old.formatSignedUsd(v), `${formatSignedUsd(v)} vs ${old.formatSignedUsd(v)}`);
  check(`formatUsdRaw ${v}`, formatUsdRaw(v) === old.formatUsdRaw(v), `${formatUsdRaw(v)} vs ${old.formatUsdRaw(v)}`);
  check(`formatUsdPrice ${v}`, formatUsdPrice(v) === old.formatUsdPrice(v));
  check(`formatToken ${v}`, formatToken(v) === old.formatToken(v));
  check(`formatTokenCount ${v}`, formatTokenCount(v) === old.formatTokenCount(v));
  check(`formatTokenUnguarded ${v}`, formatTokenUnguarded(v) === old.fmtTokenAmount(v));
}
check('hideAmount off', hideAmount('12.5') === '12.5');
check('maskAmountsInText off', maskAmountsInText('paid $1,234.56 fee') === 'paid $1,234.56 fee');
check('maskNumbersInText off', maskNumbersInText('Only 12.5 SUI') === 'Only 12.5 SUI');

setPrivacyMode(true);
check('on', isPrivacyMode() === true);
for (const v of samples) {
  check(`masked formatUsd ${v}`, formatUsd(v) === MASK);
  check(`masked formatSignedUsd ${v}`, formatSignedUsd(v) === MASK);
  check(`masked formatUsdRaw ${v}`, formatUsdRaw(v) === MASK);
  check(`masked formatToken ${v}`, formatToken(v) === MASK);
  check(`masked formatTokenCount ${v}`, formatTokenCount(v) === MASK);
  check(`masked formatTokenUnguarded ${v}`, formatTokenUnguarded(v) === MASK);
  // Stored text and prices are never masked.
  check(`exact unmasked ${v}`, formatUsdExact(v) === old.formatUsd(v));
  check(`price unmasked ${v}`, formatUsdPrice(v) === old.formatUsdPrice(v));
}
check('positionFormUtils.formatPrice unmasked', formatPrice(1234.5678) === '1,234.57');
check('hideAmount on', hideAmount('12.5') === MASK);
check('maskAmountsInText on',
  maskAmountsInText('Moved $1,234.56 and -$5 on 2026-07-01, tx 0xabc') === `Moved ${MASK} and ${MASK} on 2026-07-01, tx 0xabc`,
  maskAmountsInText('Moved $1,234.56 and -$5 on 2026-07-01, tx 0xabc'));
check('maskNumbersInText on',
  maskNumbersInText('Only 12.5 SUI is unconverted — you asked to sell 1,000.') === `Only ${MASK} SUI is unconverted — you asked to sell ${MASK}.`,
  maskNumbersInText('Only 12.5 SUI is unconverted — you asked to sell 1,000.'));

setPrivacyMode(false);
check('back off', formatUsd(12.5) === '$12.50');

console.log(`clp-format: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
