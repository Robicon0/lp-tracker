// Fails if a currency Intl.NumberFormat (or a currency toLocaleString) appears
// anywhere under app/clp-tracker outside lib/format.ts: every amount must go
// through the shared formatters so "Hide numbers" can mask it.
// Run: npx tsx scripts/clp-format-guard-test.ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..', 'app', 'clp-tracker');
const ALLOWED = join(ROOT, 'lib', 'format.ts');

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const offenders: string[] = [];
for (const file of walk(ROOT, [])) {
  if (file === ALLOWED) continue;
  const src = readFileSync(file, 'utf8');
  // An Intl.NumberFormat / toLocaleString call whose options mention a
  // currency, within the next few hundred characters.
  const re = /(Intl\.NumberFormat|toLocaleString)\s*\(([\s\S]{0,300}?)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (/currency/.test(m[2])) {
      const line = src.slice(0, m.index).split('\n').length;
      offenders.push(`${relative(join(ROOT, '..', '..'), file)}:${line}`);
    }
  }
}

if (offenders.length > 0) {
  console.log('FAIL currency formatter outside app/clp-tracker/lib/format.ts:');
  for (const o of offenders) console.log(`  ${o}`);
  process.exit(1);
}
console.log('clp-format-guard: no currency formatter outside lib/format.ts');
