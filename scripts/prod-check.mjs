#!/usr/bin/env node
// Production check (2026-10-25). Runs every 30 minutes from
// .github/workflows/prod-check.yml and alerts when production answers 5xx or
// "unavailable", shows a clean $0 for an open position, or loses a chain.
//
// Why: the Sui outage (2026-10-22) ran for days before a B7 found it by chance.
// Every check here is one read-only GET, run one after another (never in
// parallel: the Alchemy CU/s limit is shared by the whole account, rule (p)).
//
// Wallets come from PROD_CHECK_WALLETS (a GitHub Actions variable: JSON
// {"evm1","evm2","sol1","sol2","sol3","sui1","sui2"}) or, locally, from the
// "prodCheck" block of .local/wallets.json. No address is written in this file,
// in the log or in an alert. A demo wallet can close its position: the alert
// then names the check, and the fix is to put another wallet in the variable.
//
// Usage:
//   node scripts/prod-check.mjs                  # defidesh.com
//   node scripts/prod-check.mjs --base http://localhost:3000
//   node scripts/prod-check.mjs --out result.json
//   PROD_CHECK_SIMULATE=<check id> node scripts/prod-check.mjs   # force one failure (alert test)
// Exit code 0 = all good, 1 = at least one failure that held after a retry.

import { writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const argOf = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const BASE = (argOf('--base') || process.env.PROD_CHECK_BASE || 'https://www.defidesh.com').replace(/\/$/, '');
const OUT = argOf('--out');
const SIMULATE = process.env.PROD_CHECK_SIMULATE || '';
const TIMEOUT_MS = 100_000; // a route slower than this counts as hung
const RETRY_DELAY_MS = 30_000;

function loadWallets() {
  if (process.env.PROD_CHECK_WALLETS) return JSON.parse(process.env.PROD_CHECK_WALLETS);
  const file = new URL('../.local/wallets.json', import.meta.url);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')).prodCheck ?? {}) : {};
}
const W = loadWallets();
// A check whose wallet is not configured fails with 'wallet-not-configured'.
const acct = (role) => W[role] || null;

// kind: 'page' (HTML 200), 'positions' (position list), 'closed' (closed list,
// never shrinks), 'json' (any JSON 200 without an error field).
// minOpen: open positions (status != Closed) the wallet holds; each must be worth > $0.
// minCount: positions in the list (closed lists never shrink, so today's count is a floor).
const CHECKS = [
  { id: 'page-home', chain: 'site', kind: 'page', path: () => '/' },
  { id: 'page-dashboard', chain: 'site', kind: 'page', path: () => '/dashboard' },
  { id: 'page-analytics', chain: 'site', kind: 'page', path: () => '/analytics' },
  { id: 'prices', chain: 'site', kind: 'prices', path: () => '/api/prices?ids=bitcoin,sui,solana&vs_currencies=usd' },

  { id: 'uniswap-evm-1', chain: 'evm', kind: 'positions', wallet: 'evm1', path: (a) => `/api/uniswap/v3?account=${a}`, minOpen: 1 },
  { id: 'aerodrome-open-evm-1', chain: 'evm', kind: 'positions', wallet: 'evm1', path: (a) => `/api/aerodrome?account=${a}&scope=open` },
  { id: 'aerodrome-closed-evm-1', chain: 'evm', kind: 'closed', wallet: 'evm1', path: (a) => `/api/aerodrome?account=${a}&scope=closed`, minCount: 14 },
  { id: 'uniswap-unsupported-evm-1', chain: 'evm', kind: 'json', wallet: 'evm1', path: (a) => `/api/uniswap/unsupported?account=${a}` },
  { id: 'hyperswap-evm-2', chain: 'hyperevm', kind: 'closed', wallet: 'evm2', path: (a) => `/api/hyperswap?account=${a}`, minCount: 4 },

  { id: 'orca-sol-1', chain: 'solana', kind: 'positions', wallet: 'sol1', path: (a) => `/api/orca?account=${a}`, minOpen: 1 },
  { id: 'raydium-sol-2', chain: 'solana', kind: 'positions', wallet: 'sol2', path: (a) => `/api/raydium?account=${a}`, minOpen: 1 },
  { id: 'defituna-sol-3', chain: 'solana', kind: 'positions', wallet: 'sol3', path: (a) => `/api/defituna?account=${a}`, minOpen: 1 },
  { id: 'solana-closed-sol-2', chain: 'solana', kind: 'closed', wallet: 'sol2', path: (a) => `/api/solana-closed-positions?account=${a}`, minCount: 217 },

  { id: 'cetus-sui-1', chain: 'sui', kind: 'positions', wallet: 'sui1', path: (a) => `/api/cetus?account=${a}`, minOpen: 1 },
  { id: 'cetus-sui-2', chain: 'sui', kind: 'positions', wallet: 'sui2', path: (a) => `/api/cetus?account=${a}`, minOpen: 1 },
  { id: 'sui-balances-sui-2', chain: 'sui', kind: 'json', wallet: 'sui2', path: (a) => `/api/sui/balances?account=${a}` },
  { id: 'sui-closed-sui-2', chain: 'sui', kind: 'closed', wallet: 'sui2', path: (a) => `/api/sui-closed-positions?account=${a}`, minCount: 39 },
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
  } catch {
    return { status: 0, text: '', ms: Date.now() - started, error: true, timedOut: ctl.signal.aborted };
  } finally {
    clearTimeout(timer);
  }
}

// Fixed reason codes: an alert carries the check id, chain, HTTP status and one
// of these, never text from the answer.
const REASONS = [
  'simulated', 'wallet-not-configured', 'no-answer', 'request-failed', 'http-5xx', 'http-error',
  'page-no-html', 'page-error', 'not-json', 'error-field', 'failure-notice', 'price-missing',
  'no-positions-list', 'closed-list-short', 'no-positions', 'too-few-open', 'open-position-zero',
  'too-few-positions', 'unknown',
];

/** Returns null when the check passes, else a reason code from REASONS. */
function judge(check, r) {
  if (SIMULATE && SIMULATE === check.id) return 'simulated';
  if (r.notConfigured) return 'wallet-not-configured';
  if (r.timedOut) return 'no-answer';
  if (r.error) return 'request-failed';
  if (r.status >= 500) return 'http-5xx';
  if (r.status !== 200) return 'http-error';
  if (check.kind === 'page') {
    if (!/<html/i.test(r.text)) return 'page-no-html';
    if (/Application error|Internal Server Error/i.test(r.text)) return 'page-error';
    return null;
  }
  let j;
  try { j = JSON.parse(r.text); } catch { return 'not-json'; }
  if (j && typeof j.error === 'string') return 'error-field';
  const bad = (Array.isArray(j?.truncated) ? j.truncated : [])
    .map((t) => String(t?.reason ?? ''))
    .filter((reason) => !NOT_A_FAILURE.has(reason) && FAILURE_NOTICE.test(reason));
  if (bad.length > 0) return 'failure-notice';
  if (check.kind === 'prices') {
    const zero = Object.entries(j).filter(([, v]) => !(Number(v?.usd) > 0));
    return Object.keys(j).length === 0 || zero.length > 0 ? 'price-missing' : null;
  }
  if (check.kind === 'json') return null;
  const positions = Array.isArray(j?.positions) ? j.positions : null;
  if (!positions) return 'no-positions-list';
  if (check.kind === 'closed') {
    return check.minCount && positions.length < check.minCount ? 'closed-list-short' : null;
  }
  const open = positions.filter((p) => p.status !== 'Closed');
  if (check.minOpen && open.length < check.minOpen) return positions.length === 0 ? 'no-positions' : 'too-few-open';
  if (open.some((p) => !(Number(p.value) > 0))) return 'open-position-zero';
  if (check.minCount && positions.length < check.minCount) return 'too-few-positions';
  return null;
}

async function runCheck(check) {
  const wallet = check.wallet ? acct(check.wallet) : '';
  const r = wallet === null ? { status: 0, text: '', ms: 0, notConfigured: true } : await fetchOnce(check.path(wallet));
  const reason = judge(check, r);
  // Only a fixed code may leave this script (it ends up in a public issue).
  return { ...check, status: r.status, ms: r.ms, reason: reason && !REASONS.includes(reason) ? 'unknown' : reason };
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
    failures: failures.map(({ id, chain, status, reason }) => ({ id, chain, status, reason })),
    fingerprint: failures.map((f) => `${f.id}:${f.reason}`).sort().join('|'),
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

main().catch((e) => { console.error('prod-check crashed:', e?.name ?? 'Error'); process.exit(2); });
