#!/usr/bin/env node
// Test for the pre-commit check (scripts/hooks/pre-commit-scan.mjs). Builds a
// scratch git repo in the OS temp folder, installs the hook there and makes
// real `git commit` attempts. Every key and address below is generated at run
// time, so this file holds none. Exit 0 = every case behaves, 1 otherwise.
//
// USAGE  node scripts/hooks/pre-commit-scan-test.mjs

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const dir = mkdtempSync(path.join(os.tmpdir(), 'precommit-test-'));

const B58 = '123456789' + 'ABCDEFGHJKLMNPQRSTUVWXYZ' + 'abcdefghijkmnopqrstuvwxyz';
const rand = (alphabet, n) => [...randomBytes(n)].map((b) => alphabet[b % alphabet.length]).join('');
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' + 'abcdefghijklmnopqrstuvwxyz' + '0123456789';
const mixed = (n) => { let s; do s = rand(ALNUM, n); while (!(/[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s))); return s; };
const b58 = (n) => { let s; do s = rand(B58, n); while (!(/[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s))); return s; };
const hex = (n) => rand('0123456789abcdef', n);

const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
git('init', '-q');
git('config', 'user.email', 'test@example.invalid');
git('config', 'user.name', 'pre-commit test');
git('config', 'commit.gpgsign', 'false');
mkdirSync(path.join(dir, 'scripts', 'hooks'), { recursive: true });
mkdirSync(path.join(dir, '.githooks'), { recursive: true });
copyFileSync(path.join(repoRoot, 'scripts/hooks/pre-commit-scan.mjs'), path.join(dir, 'scripts/hooks/pre-commit-scan.mjs'));
copyFileSync(path.join(repoRoot, '.githooks/pre-commit'), path.join(dir, '.githooks/pre-commit'));
chmodSync(path.join(dir, '.githooks/pre-commit'), 0o755);
writeFileSync(path.join(dir, '.gitignore'), '.env*\n.local/\n');
git('config', 'core.hooksPath', '.githooks');
git('add', '-A');
git('commit', '-q', '-m', 'baseline');

let pass = 0, fail = 0;
function attempt(name, content, { expectBlocked, kind, secret, env = {} }) {
  writeFileSync(path.join(dir, 'case.js'), content);
  git('add', 'case.js');
  const r = spawnSync('git', ['commit', '-q', '-m', name], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
  const out = r.stdout + r.stderr;
  const blocked = r.status !== 0;
  const problems = [];
  if (blocked !== expectBlocked) problems.push(blocked ? 'was blocked' : 'was NOT blocked');
  if (kind && !out.includes(kind)) problems.push(`output lacks "${kind}"`);
  if (secret && out.includes(secret)) problems.push('output printed the value');
  if (problems.length) { fail++; console.log(`FAIL  ${name}: ${problems.join("; ")}`); if (process.env.DEBUG) console.log(out); } else { pass++; console.log(`PASS  ${name}`); }
  if (blocked) git('reset', '-q', 'HEAD', 'case.js');
  rmSync(path.join(dir, 'case.js'), { force: true });
}

// Keys
const k1 = mixed(36);
attempt('api key in a header is blocked', `fetch(u, { headers: { 'x-api-key': '${k1}' } });\n`, { expectBlocked: true, kind: 'api key header', secret: k1 });
const k2 = mixed(32);
attempt('key in a provider URL is blocked', `const RPC = 'https://base-mainnet.g.alchemy.com/v2/${k2}';\n`, { expectBlocked: true, kind: 'provider URL key', secret: k2 });
const k3 = mixed(37) + "_0O"; // "_", "0", "O" are not base58, so it cannot read as an address
attempt('random-looking literal is blocked', `const TOKEN_X = "${k3}";\n`, { expectBlocked: true, kind: 'key-like string', secret: k3 });
const k4 = mixed(32);
writeFileSync(path.join(dir, '.env.local'), `SOME_KEY=${k4}\n`);
attempt('a value from a local .env file is blocked', `// pasted: ${k4.slice(0, 16)}-${k4.slice(16)}\nconst v = '${k4}';\n`, { expectBlocked: true, kind: 'value from a local .env file', secret: k4 });
attempt('reading a key from the environment passes', `const KEY = process.env.HELIUS_API_KEY;\nconst url = \`https://rpc.example/?api-key=\${KEY}\`;\n`, { expectBlocked: false });

// Addresses
const evm = '0x' + hex(40);
attempt('new 0x (EVM) address is blocked', `const W = '${evm}';\n`, { expectBlocked: true, kind: 'new 0x address', secret: evm });
const sui = '0x' + hex(64);
attempt('new 0x (Sui) address is blocked', `const W = '${sui}';\n`, { expectBlocked: true, kind: 'new 0x address', secret: sui });
const sol = b58(44);
attempt('new base58 (Solana) address is blocked', `const W = '${sol}';\n`, { expectBlocked: true, kind: 'new base58 address', secret: sol });

// An address already in HEAD passes, unless it is in the local wallet file.
const known = '0x' + hex(40);
writeFileSync(path.join(dir, 'known.js'), `export const POOL = '${known}';\n`);
git('add', 'known.js');
execFileSync('git', ['commit', '-q', '--no-verify', '-m', 'seed a known address'], { cwd: dir });
attempt('address already in the tree passes', `const again = '${known}';\n`, { expectBlocked: false });
attempt('address listed in .local/wallets.json is blocked even if in the tree', `const listed = '${known}';\n`, {
  expectBlocked: true, kind: 'listed in .local/wallets.json', secret: known,
  env: { LOCAL_WALLETS_JSON: JSON.stringify({ private: { account1: { evm: known } } }) },
});
const contract = '0x' + hex(40);
writeFileSync(path.join(dir, '.githooks/address-allowlist.txt'), `${contract}  # a pool\n`);
git('add', '.githooks/address-allowlist.txt');
execFileSync('git', ['commit', '-q', '--no-verify', '-m', 'allowlist'], { cwd: dir });
attempt('allowlisted contract address passes', `const POOL2 = '${contract}';\n`, { expectBlocked: false });
attempt('ordinary code passes', `export function add(a, b) { return a + b; } // getCachedOnlyDefillamaPrice\n`, { expectBlocked: false });

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
