// Open positions first; fee and history scans after the first row has painted.
//
// The closed-position history scans and the wallet-wide fee scans are the
// heaviest requests a page makes, and they used to leave in the same instant as
// the open-position requests. They now wait for this gate: it opens once the
// first open-position rows have been painted, or every positions source has
// answered with nothing to show, or after MAX_WAIT_MS — a stuck positions
// source must never hold the history back indefinitely.
//
// Measured 2026-10-10, do not re-try without new evidence: starting the
// open-position requests from an inline <head> script (before hydration) made
// the first row LATER on Chromium (4.4 s -> 5.8 s median): the early requests
// slowed the 1.2 MB script download that hydration waits for, and the rows
// cannot render before hydration anyway. Phones gained under 0.2 s.
const MAX_WAIT_MS = 8_000;

let opened = false;
let waiters: Array<() => void> = [];
let fallback: ReturnType<typeof setTimeout> | null = null;

function open(): void {
  if (opened) return;
  opened = true;
  if (fallback) { clearTimeout(fallback); fallback = null; }
  const run = waiters; waiters = [];
  for (const w of run) w();
}

/** Called by PositionsContext when rows exist, or when every source has settled. */
export function markFirstRowsReady(): void {
  if (opened) return;
  // Two frames: let the rows commit and paint before the scans take the network.
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(open));
  else open();
}

/** Resolves when history and fee scans may start. Resolves at once on the server. */
export function whenFirstRowsPainted(): Promise<void> {
  if (opened || typeof window === 'undefined') return Promise.resolve();
  if (!fallback) fallback = setTimeout(open, MAX_WAIT_MS);
  return new Promise<void>((resolve) => { waiters.push(resolve); });
}
