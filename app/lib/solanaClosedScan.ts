// app/lib/solanaClosedScan.ts
//
// ONE closed-Solana history request per wallet, shared by every consumer.
//
// The dashboard and analytics read the same answer from two hooks (useLpPnl for
// Capital G/L, useWalletLevelFees for Fee Income), each with its own retry loop.
// Measured 2026-10-28 on 6NcbT9 and upgMGF: the two loops asked the route
// separately, so each visit sent two requests per round. The server joins
// identical requests on one instance, but not across instances. Here a request
// that is already running for the wallet is JOINED, and an answer is reused:
//   - a complete (or capped) answer for 5 minutes,
//   - a "still reading" answer never (each round must ask again; a round that
//     starts while the other loop's request runs joins it),
//   - a failure never.
// The wallet's state is published so the page can say how far the read is
// ("reading history (2,000 of about 14,000)") and show "—" until it is whole.

import {
  isScanInProgress, LOOKUP_CAPPED, LOOKUP_FAILED, LOOKUP_UNAVAILABLE, type RouteTruncation,
} from './enumerationTruncation';

export interface SolanaClosedJson {
  positions?: unknown[];
  truncated?: RouteTruncation[];
  progress?: { scanned: number; total: number | null; totalAtLeast: boolean };
}

export type SolanaClosedAnswer = { ok: true; json: SolanaClosedJson } | { ok: false };

/** `reading`: no answer yet, or the history is still being read. */
export type SolanaHistoryPhase = 'reading' | 'complete' | 'capped' | 'failed';
export interface SolanaHistoryState {
  phase: SolanaHistoryPhase;
  scanned: number | null;
  total: number | null;
  totalAtLeast: boolean;
}

const CLIENT_BUDGET_MS = 305_000;   // just above the route's maxDuration (300 s)
const REUSE_FINAL_MS = 5 * 60_000;

const inFlight = new Map<string, Promise<SolanaClosedAnswer>>();
const lastAnswer = new Map<string, { at: number; answer: SolanaClosedAnswer; reading: boolean }>();
const states = new Map<string, SolanaHistoryState>();
const listeners = new Set<() => void>();
let version = 0;

function setState(account: string, s: SolanaHistoryState) {
  states.set(account, s);
  version += 1;
  for (const l of listeners) l();
}

export function phaseOf(json: SolanaClosedJson): SolanaHistoryPhase {
  const t = json.truncated;
  if (isScanInProgress(t)) return 'reading';
  if (t?.some((x) => x?.reason === LOOKUP_FAILED || x?.reason === LOOKUP_UNAVAILABLE)) return 'failed';
  if (t?.some((x) => x?.reason === LOOKUP_CAPPED)) return 'capped';
  return 'complete';
}

const urlOf = (account: string) => `/api/solana-closed-positions?account=${encodeURIComponent(account)}`;

async function request(account: string): Promise<SolanaClosedAnswer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLIENT_BUDGET_MS);
  try {
    const res = await fetch(urlOf(account), { signal: controller.signal });
    if (!res.ok) return { ok: false };
    return { ok: true, json: (await res.json()) as SolanaClosedJson };
  } catch {
    return { ok: false }; // aborted (budget) or network error: a failed read, never "no positions"
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The closed-Solana answer for one wallet. Joins a request already running for
 * it, and reuses a recent answer (see the header); otherwise asks the route.
 * The account string is used as given (Solana addresses are case-sensitive).
 */
export function fetchSolanaClosed(account: string): Promise<SolanaClosedAnswer> {
  const running = inFlight.get(account);
  if (running) return running;
  const last = lastAnswer.get(account);
  if (last && last.answer.ok && !last.reading && Date.now() - last.at < REUSE_FINAL_MS) return Promise.resolve(last.answer);
  if (!states.has(account)) setState(account, { phase: 'reading', scanned: null, total: null, totalAtLeast: false });
  const p = request(account).then((answer) => {
    if (!answer.ok) {
      lastAnswer.delete(account);
      setState(account, { phase: 'failed', scanned: null, total: null, totalAtLeast: false });
      return answer;
    }
    const phase = phaseOf(answer.json);
    lastAnswer.set(account, { at: Date.now(), answer, reading: phase === 'reading' });
    const pr = answer.json.progress;
    setState(account, {
      phase,
      scanned: phase === 'reading' && pr ? pr.scanned : null,
      total: phase === 'reading' && pr ? pr.total : null,
      totalAtLeast: phase === 'reading' && pr ? pr.totalAtLeast : false,
    });
    return answer;
  });
  inFlight.set(account, p);
  return p.finally(() => { inFlight.delete(account); });
}

/** State of each wallet's closed-Solana read; a wallet not asked yet is `reading`. */
export function solanaHistoryStates(accounts: readonly string[]): SolanaHistoryState[] {
  return accounts.map((a) => states.get(a) ?? { phase: 'reading', scanned: null, total: null, totalAtLeast: false });
}

export function subscribeSolanaHistory(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function solanaHistoryVersion(): number {
  return version;
}

/** Test hook: forget every answer and state. */
export function _resetSolanaClosedScan() {
  inFlight.clear(); lastAnswer.clear(); states.clear(); version += 1;
}

/**
 * One summary over several wallets, for the page.
 * `hold` is true while any wallet's history is not whole (still reading, or
 * failed): the figures that include it are not shown, never shown as a total.
 */
export function summarizeSolanaHistory(list: readonly SolanaHistoryState[]): {
  hold: boolean;
  note: string | null;
} {
  if (list.length === 0) return { hold: false, note: null };
  if (list.some((s) => s.phase === 'failed')) {
    return { hold: true, note: "couldn't read Solana closed history" };
  }
  const reading = list.filter((s) => s.phase === 'reading');
  if (reading.length === 0) return { hold: false, note: null };
  const withCount = reading.filter((s) => s.scanned != null);
  if (withCount.length === 0) return { hold: true, note: 'reading Solana closed history…' };
  const scanned = withCount.reduce((a, s) => a + (s.scanned ?? 0), 0);
  const allTotals = withCount.every((s) => s.total != null);
  if (!allTotals) return { hold: true, note: `reading history (${fmtCount(scanned)} transactions read)` };
  const total = withCount.reduce((a, s) => a + (s.total ?? 0), 0);
  const atLeast = withCount.some((s) => s.totalAtLeast);
  return { hold: true, note: `reading history (${fmtCount(scanned)} of ${atLeast ? 'at least' : 'about'} ${fmtCount(roundTotal(total))})` };
}

function fmtCount(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** "about 14,000": two significant figures above 1,000. */
function roundTotal(n: number): number {
  if (n < 1_000) return n;
  const mag = 10 ** (Math.floor(Math.log10(n)) - 1);
  return Math.round(n / mag) * mag;
}
