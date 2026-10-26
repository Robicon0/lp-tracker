#!/usr/bin/env node
// Pre-commit check (2026-10-27): blocks a commit whose ADDED lines hold a
// key-like string or a full wallet address. Run by .githooks/pre-commit.
// Install once per clone:  git config core.hooksPath .githooks
//
// Blocked, always:
//   - a value from a local .env* file (the file is never read into the output);
//   - a provider-shaped key: x-api-key / Bearer / ?api-key= / alchemy.com/v2/<key>,
//     `apiKey = "..."`, sk-..., ghp_..., github_pat_..., AKIA..., JWTs, private-key blocks;
//   - any address listed in .local/wallets.json (the one allowed file, git-ignored).
// Blocked unless it is already in the committed tree (HEAD) or listed in
// .githooks/address-allowlist.txt (public CONTRACT addresses only, never a wallet):
//   - a full 0x address (20 or 32 bytes: EVM, Sui) or a base58 address (Solana);
//   - a long random-looking string literal (generic key shape).
//
// Output names the file, the line number and the kind of match, never the value.
// Exit 0 = clean, 1 = blocked. Test: node scripts/hooks/pre-commit-scan-test.mjs

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ALLOWED_FILE = '.local/wallets.json';
const SKIP_FILES = new Set(['package-lock.json', ALLOWED_FILE]);

const git = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
const root = git(['rev-parse', '--show-toplevel']).trim();

const KEY_PATTERNS = [
  ['api key header', /x-api-key["']?\s*[:=,]\s*["']?[A-Za-z0-9_-]{16,}/i],
  ['bearer token', /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/],
  ['key in URL', /[?&](?:api[-_]?key|apikey|key|token|access_token)=[A-Za-z0-9_-]{16,}/i],
  ['provider URL key', /\.alchemy\.com\/v2\/[A-Za-z0-9_-]{16,}/i],
  ['key assignment', /\b[A-Za-z_]*(?:api[-_]?key|apikey|secret|password|passwd|auth[-_]?token|access[-_]?token|private[-_]?key)\b["']?\s*[:=]\s*["'`][A-Za-z0-9_\-./+=]{16,}["'`]/i],
  ['provider key prefix', /\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,})/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

const B58 = '1-9A-HJ-NP-Za-km-z';
const ADDRESS_PATTERNS = [
  ['0x address', /(?<![0-9A-Za-z])0x(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{40})(?![0-9A-Za-z])/g],
  ['base58 address', new RegExp(`(?<![${B58}0OIl])[${B58}]{32,44}(?![${B58}0OIl])`, 'g')],
];
// Long random-looking quoted literal: letters and digits mixed, both cases.
const GENERIC_KEY = /["'`]([A-Za-z0-9_-]{28,})["'`]/g;
const randomLooking = (s) => /[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s) && !/^[0-9a-fA-F]+$/.test(s);

function envSecrets() {
  const out = new Set();
  for (const name of readdirSync(root)) {
    if (!/^\.env/.test(name) && !/\.env$/.test(name)) continue;
    if (/example$/.test(name)) continue;
    const text = readFileSync(path.join(root, name), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/);
      if (!m) continue;
      for (const tok of m[1].replace(/^["']|["']$/g, '').match(/[A-Za-z0-9_-]{16,}/g) ?? []) {
        if (/[0-9]/.test(tok) && /[A-Za-z]/.test(tok)) out.add(tok);
      }
    }
  }
  return out;
}

function walletList() {
  const lower = new Set();
  let raw = process.env.LOCAL_WALLETS_JSON;
  const file = path.join(root, ALLOWED_FILE);
  if (!raw && existsSync(file)) raw = readFileSync(file, 'utf8');
  if (!raw) return lower;
  const walk = (v) => {
    if (typeof v === 'string') { if (/^(0x[0-9a-fA-F]{40,64}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(v)) lower.add(v.toLowerCase()); }
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(JSON.parse(raw));
  return lower;
}

function allowlist() {
  const file = path.join(root, '.githooks', 'address-allowlist.txt');
  if (!existsSync(file)) return new Set();
  return new Set(readFileSync(file, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim().toLowerCase()).filter(Boolean));
}

const hasHead = (() => { try { git(['rev-parse', '--verify', '-q', 'HEAD']); return true; } catch { return false; } })();
const inHeadCache = new Map();
function inHead(s) {
  if (!hasHead) return false;
  if (!inHeadCache.has(s)) {
    let found = false;
    try { git(['grep', '-q', '-F', '-e', s, 'HEAD', '--', '.', ':!package-lock.json'], { stdio: 'ignore' }); found = true; } catch { found = false; }
    inHeadCache.set(s, found);
  }
  return inHeadCache.get(s);
}

function addedLines(file) {
  const diff = git(['diff', '--cached', '-U0', '--no-color', '--no-ext-diff', '--', file]);
  if (/^Binary files /m.test(diff)) return [];
  const out = [];
  let n = 0;
  for (const line of diff.split('\n')) {
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (h) { n = Number(h[1]); continue; }
    if (line.startsWith('+++')) continue;
    if (line.startsWith('+')) { out.push([n, line.slice(1)]); n++; }
  }
  return out;
}

const files = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean);
const secrets = envSecrets();
const wallets = walletList();
const allowed = allowlist();
const hits = [];

for (const file of files) {
  if (SKIP_FILES.has(file)) continue;
  for (const [n, text] of addedLines(file)) {
    const at = `${file}:${n}`;
    for (const s of secrets) if (text.includes(s)) hits.push([at, 'value from a local .env file']);
    for (const [kind, re] of KEY_PATTERNS) {
      const m = text.match(re);
      if (m && !/process\.env|\$\{|\$[A-Z_]/.test(m[0])) hits.push([at, kind]);
    }
    for (const [kind, re] of ADDRESS_PATTERNS) {
      for (const m of text.matchAll(re)) {
        const a = m[0];
        if (kind === 'base58 address' && !randomLooking(a)) continue;
        const low = a.toLowerCase();
        if (wallets.has(low)) { hits.push([at, `${kind} listed in ${ALLOWED_FILE}`]); continue; }
        if (allowed.has(low) || inHead(a)) continue;
        hits.push([at, `new ${kind}`]);
      }
    }
    for (const m of text.matchAll(GENERIC_KEY)) {
      const s = m[1];
      if (!randomLooking(s) || new RegExp(`^[${B58}]{32,44}$`).test(s)) continue; // base58 handled above
      if (allowed.has(s.toLowerCase()) || inHead(s)) continue;
      hits.push([at, 'key-like string']);
    }
  }
}

if (hits.length) {
  console.error('pre-commit: blocked. Remove these (values are not shown):');
  for (const [at, kind] of hits) console.error(`  ${at}  ${kind}`);
  console.error(`Wallet addresses belong in ${ALLOWED_FILE} (git-ignored); keys in environment variables.`);
  console.error('A new public CONTRACT address can be listed in .githooks/address-allowlist.txt.');
  process.exit(1);
}
process.exit(0);
