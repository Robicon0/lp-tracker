#!/usr/bin/env node
// Production check (2026-10-25). Runs every 30 minutes from
// .github/workflows/prod-check.yml and alerts when production answers 5xx or
// "unavailable", shows a clean $0 for an open position, or loses a chain.
//
// Why: the Sui outage (2026-10-22) ran for days before a B7 found it by chance.
// Every check here is one read-only GET, run one after another (never in
// parallel: the Alchemy CU/s limit is shared by the whole account, rule (p)).
//
// Wallets are public addresses already in the repo or third-party demo wallets
// with live positions. A third-party wallet can close its position: the alert
// then names that wallet, and the fix is to pick another one below.
//
// Usage:
//   node scripts/prod-check.mjs                  # defidesh.com
//   node scripts/prod-check.mjs --base http://localhost:3000
//   node scripts/prod-check.mjs --out result.json
//   PROD_CHECK_SIMULATE=<check id> node scripts/prod-check.mjs   # force one failure (alert test)
// Exit code 0 = all good, 1 = at least one failure that held after a retry.

import { writeFileSync, appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const argOf = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const BASE = (argOf('--base') || process.env.PROD_CHECK_BASE || 'https://www.defidesh.com').replace(/\/$/, '');
const OUT = argOf('--out');
const SIMULATE = process.env.PROD_CHECK_SIMULATE || '';
const TIMEOUT_MS = 100_000; // a route slower than this counts as hung
const RETRY_DELAY_MS = 30_000;

const EVM_A1 = '0xD99a9e66d000d4024dC77f00f784Cc45F8804F20'; // Account 1 EVM (in CLAUDE.md)
const EVM_A2 = '0xEf93B7f19dcEf8E5f9c5F41CBBCe9e78B16B8d0C'; // Account 2 EVM (in CLAUDE.md)
const SOL_TUNA = '6NcbT9g7xDTaBpAVJGjfQK4jW81KxBA5zH3nPdQVu9od'; // DefiTuna regression wallet (in CLAUDE.md)
const SOL_2RR3 = '2rr3SFuM8YNFcn9RUvqGNPki8rxaXjHDscQuy7wNJTpn'; // Solana test wallet (in CLAUDE.md)
const SOL_ORCA = 'H8r6UKSRPz6bVA2NqPj6s7raMgLfBPFQsnSs4xhqf595'; // third party, open Orca position
const SUI_9D6E = '0x9d6ea1972a50e987182bc937f1ea5fca1c1e3e4190ae36751cf273d01a13b1f9'; // third party, 13 open Cetus
const SUI_0256 = '0x0256c4c596fef5d0e0db6303982653ef283eb32162f8c3967d8b30488ac7e6ea'; // third party, open Cetus

// kind: 'page' (HTML 200), 'positions' (position list), 'closed' (closed list,
// never shrinks), 'json' (any JSON 200 without an error field).
// minOpen: open positions (status != Closed) the wallet holds; each must be worth > $0.
// minCount: positions in the list (closed lists never shrink, so today's count is a floor).
const CHECKS = [
  { id: 'page-home', chain: 'site', kind: 'page', path: '/' },
  { id: 'page-dashboard', chain: 'site', kind: 'page', path: '/dashboard' },
  { id: 'page-analytics', chain: 'site', kind: 'page', path: '/analytics' },
  { id: 'prices', chain: 'site', kind: 'prices', path: '/api/prices?ids=bitcoin,sui,solana&vs_currencies=usd' },

  { id: 'uniswap-a1', chain: 'evm', kind: 'positions', path: `/api/uniswap/v3?account=${EVM_A1}`, minOpen: 1 },
  { id: 'aerodrome-open-a1', chain: 'evm', kind: 'positions', path: `/api/aerodrome?account=${EVM_A1}&scope=open` },
  { id: 'aerodrome-closed-a1', chain: 'evm', kind: 'closed', path: `/api/aerodrome?account=${EVM_A1}&scope=closed`, minCount: 14 },
  { id: 'uniswap-unsupported-a1', chain: 'evm', kind: 'json', path: `/api/uniswap/unsupported?account=${EVM_A1}` },
  { id: 'hyperswap-a2', chain: 'hyperevm', kind: 'closed', path: `/api/hyperswap?account=${EVM_A2}`, minCount: 4 },

  { id: 'orca-h8r6', chain: 'solana', kind: 'positions', path: `/api/orca?account=${SOL_ORCA}`, minOpen: 1 },
  { id: 'raydium-2rr3', chain: 'solana', kind: 'positions', path: `/api/raydium?account=${SOL_2RR3}`, minOpen: 1 },
  { id: 'defituna-6ncb', chain: 'solana', kind: 'positions', path: `/api/defituna?account=${SOL_TUNA}`, minOpen: 1 },
  { id: 'solana-closed-2rr3', chain: 'solana', kind: 'closed', path: `/api/solana-closed-positions?account=${SOL_2RR3}`, minCount: 217 },

  { id: 'cetus-9d6e', chain: 'sui', kind: 'positions', path: `/api/cetus?account=${SUI_9D6E}`, minOpen: 1 },
  { id: 'cetus-0256', chain: 'sui', kind: 'positions', path: `/api/cetus?account=${SUI_0256}`, minOpen: 1 },
  { id: 'sui-balances-0256', chain: 'sui', kind: 'json', path: `/api/sui/balances?account=${SUI_0256}` },
  { id: 'sui-closed-0256', chain: 'sui', kind: 'closed', path: `/api/sui-closed-positions?account=${SUI_0256}`, minCount: 39 },
];

// Notices that describe a failed or unavailable read. Information notices
// (pool statistics, a vault position, a scan still reading or capped, the
// Aerodrome pool-ceiling note) are not failures.
const NOT_A_FAILURE = new Set([
  'pool-stats-unavailable', 'pool-stats-last-known', 'not-held-open', 'store-write-failed',
  'lookup-in-progress', 'lookup-capped', 'pool-scan-ceiling',
]);
const FAILURE_NOTICE = /unavailable|failed|unreadable|unverified|unchecked|excluded|kept-stored/;

async function fetchOnce(path) {
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(BASE + path, { signal: ctl.signal, headers: { 'user-agent': 'defidesh-prod-check' } });
    const text = await res.text();
    return { status: res.status, text, ms: Date.now() - started };
  } catch (e) {
    return { status: 0, text: '', ms: Date.now() - started, error: ctl.signal.aborted ? `no answer in ${TIMEOUT_MS / 1000} s` : String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Returns null when the check passes, else a one-line reason. */
function judge(check, r) {
  if (SIMULATE && SIMULATE === check.id) return 'simulated failure (alert test)';
  if (r.error) return `request failed: ${r.error}`;
  if (r.status >= 500) return `HTTP ${r.status}${shortError(r.text)}`;
  if (r.status !== 200) return `HTTP ${r.status}${shortError(r.text)}`;
  if (check.kind === 'page') {
    if (!/<html/i.test(r.text)) return 'page answered 200 without HTML';
    if (/Application error|Internal Server Error/i.test(r.text)) return 'page shows an error';
    return null;
  }
  let j;
  try { j = JSON.parse(r.text); } catch { return 'answer is not JSON'; }
  if (j && typeof j.error === 'string') return `answered error "${j.error}"`;
  const bad = (Array.isArray(j?.truncated) ? j.truncated : [])
    .map((t) => String(t?.reason ?? ''))
    .filter((reason) => !NOT_A_FAILURE.has(reason) && FAILURE_NOTICE.test(reason));
  if (bad.length > 0) return `notice: ${[...new Set(bad)].join(', ')}`;
  if (check.kind === 'prices') {
    const zero = Object.entries(j).filter(([, v]) => !(Number(v?.usd) > 0)).map(([k]) => k);
    if (Object.keys(j).length === 0 || zero.length > 0) return `no price for ${zero.join(', ') || 'any coin'}`;
    return null;
  }
  if (check.kind === 'json') return null;
  const positions = Array.isArray(j?.positions) ? j.positions : null;
  if (!positions) return 'answer has no positions list';
  if (check.kind === 'closed') {
    return check.minCount && positions.length < check.minCount ? `${positions.length} positions, expected at least ${check.minCount}` : null;
  }
  const open = positions.filter((p) => p.status !== 'Closed');
  const zeroOpen = open.filter((p) => !(Number(p.value) > 0));
  if (check.minOpen && open.length < check.minOpen) {
    return positions.length === 0
      ? 'no positions at all (chain lost, or the demo wallet closed everything)'
      : `${open.length} open positions, expected at least ${check.minOpen} (the demo wallet may have closed its position)`;
  }
  if (zeroOpen.length > 0) return `${zeroOpen.length} open position(s) worth $0.00`;
  if (check.minCount && positions.length < check.minCount) return `${positions.length} positions, expected at least ${check.minCount}`;
  return null;
}

function shortError(text) {
  try { const j = JSON.parse(text); if (j?.error) return ` "${String(j.error).slice(0, 80)}"`; } catch { /* not JSON */ }
  return '';
}

async function runCheck(check) {
  const r = await fetchOnce(check.path);
  return { ...check, status: r.status, ms: r.ms, reason: judge(check, r) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const measuredAt = new Date().toISOString();
  const results = [];
  for (const c of CHECKS) results.push(await runCheck(c));

  // A failure must hold on a second try 30 s later before it alerts.
  const failing = results.filter((r) => r.reason);
  if (failing.length > 0) {
    await sleep(RETRY_DELAY_MS);
    for (const f of failing) {
      const again = await runCheck(f);
      Object.assign(f, { status: again.status, ms: again.ms, reason: again.reason, retried: true });
    }
  }

  const failures = results.filter((r) => r.reason);
  const chainsLost = [...new Set(results.map((r) => r.chain))]
    .filter((ch) => results.filter((r) => r.chain === ch).every((r) => r.reason));
  const summary = {
    ok: failures.length === 0,
    base: BASE,
    measuredAt,
    finishedAt: new Date().toISOString(),
    chainsLost,
    failures: failures.map(({ id, chain, path, status, reason }) => ({ id, chain, path, status, reason })),
    fingerprint: failures.map((f) => `${f.id}:${f.reason.replace(/\d+(\.\d+)?/g, 'n')}`).sort().join('|'),
    checks: results.map(({ id, chain, status, ms, reason, retried }) => ({ id, chain, status, ms, ok: !reason, ...(reason ? { reason } : {}), ...(retried ? { retried } : {}) })),
  };

  const lines = [
    `Production check ${summary.ok ? 'PASSED' : 'FAILED'} — ${BASE} — measured ${measuredAt}`,
    ...(chainsLost.length ? [`Chains with every check failing: ${chainsLost.join(', ')}`] : []),
    ...results.map((r) => `${r.reason ? 'FAIL' : 'ok  '}  ${r.chain.padEnd(8)} ${r.id.padEnd(24)} ${String(r.status).padEnd(4)} ${String(r.ms).padStart(6)} ms${r.reason ? `  ${r.reason}` : ''}`),
  ];
  console.log(lines.join('\n'));
  if (OUT) writeFileSync(OUT, JSON.stringify(summary, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, '```\n' + lines.join('\n') + '\n```\n');
  }
  process.exit(summary.ok ? 0 : 1);
}

main().catch((e) => { console.error('prod-check crashed:', e); process.exit(2); });
