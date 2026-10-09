/**
 * Enumeration-truncation registry (queue item C, Phase 1).
 *
 * Several position-enumeration paths carry a HARDCODED cap and, on hitting it,
 * returned a well-formed partial result that is indistinguishable from a
 * complete one — no banner, no error, no exclusion entry. A wallet with more
 * positions than the cap simply saw fewer positions than it owns, and a `count`
 * computed AFTER truncation confirmed the wrong number back to it.
 *
 * That is architecture Rule 11 at the enumeration layer: degrade VISIBLY, never
 * silently differ. It is also the same failure class as queue item B — an
 * incomplete scan presenting as a complete one.
 *
 * Phase 1 does NOT raise any cap. It makes every cap ANNOUNCE ITSELF:
 *
 *   1. Each capped route emits an additive `truncated: RouteTruncation[]` field
 *      in its JSON response whenever a cap actually bound this request.
 *   2. The client fetch wrapper hands that array to `applyTruncationNotices`,
 *      which is keyed by (source, address) so a later complete response CLEARS
 *      a stale notice.
 *   3. `useTruncationNotices()` subscribes the UI to the registry, and the
 *      dashboard / analytics / lending pages render the notice.
 *
 * Phases 2 and 3 raise or remove the caps themselves. Until then this is the
 * honest signal, and it stays useful afterwards as a regression tripwire for
 * any cap we do not manage to eliminate.
 */

/** What a route reports about ONE cap that bound the current request. */
export interface RouteTruncation {
  /**
   * What the cap applied to, in user-facing terms — a chain ("Arbitrum"), a
   * protocol ("ProjectX"), or a named scan ("closed-position recovery").
   */
  scope: string;
  /** The hardcoded cap that bound. */
  cap: number;
  /** How many items this request actually returned within that scope. */
  returned: number;
  /**
   * The true total when the route can know it (e.g. ERC-721 `balanceOf` is
   * exact), else null when the cap merely SATURATED and the real total is
   * unknown (e.g. Sugar returned exactly `limit` rows).
   */
  knownTotal: number | null;
  /** Short machine-ish cause, for logs and support. */
  reason: string;
}

/**
 * Reason codes for a notice that reports a FAILED LOOKUP rather than a cap.
 *
 * Queue item B / ITEM 0i. A cap and a failure are different causes with the SAME
 * user-facing consequence — "what you are looking at is not everything" — so they
 * share this channel rather than growing a second one. The distinction that
 * matters is not cap-vs-failure, it is COMPLETE-vs-NOT, and a caller that cannot
 * say which must never present its result as complete.
 *
 * Why this exists: an enumeration that failed used to `return []`, which is
 * indistinguishable from "this wallet owns nothing". The route then emitted a
 * well-formed, confident, WRONG answer — no banner, no exclusion, no error. That
 * is architecture Rule 11 inverted: it did not degrade, it erased. Measured live
 * 2026-09-19: every Aerodrome closed position vanished from the Closed tab,
 * Capital G/L and Fee Income for every Base user, because three public RPC
 * providers had closed their free `eth_getLogs` tiers and the failure was
 * swallowed at `evmEverOwnedNftIds.ts`.
 *
 * `cap` / `returned` are 0 for these: no cap bound, nothing was returned. The
 * copy branches in `describeTruncation` BEFORE reading either, so the
 * cap-oriented wording can never be applied to a failure.
 */
export const LOOKUP_FAILED = 'lookup-failed';
export const LOOKUP_UNAVAILABLE = 'lookup-unavailable';
/**
 * A long history scan that is still being read. The scan is resumable: it stops
 * at its time budget, returns what it has, and the next request continues. The
 * client asks again while it sees this reason (see `isScanInProgress`).
 */
export const LOOKUP_IN_PROGRESS = 'lookup-in-progress';
/**
 * A history too long to read in full. Only its most recent part is included,
 * and asking again does not change that.
 */
export const LOOKUP_CAPPED = 'lookup-capped';

export type LookupReason =
  | typeof LOOKUP_FAILED | typeof LOOKUP_UNAVAILABLE | typeof LOOKUP_IN_PROGRESS | typeof LOOKUP_CAPPED;

/** The notice for a history scan in a given state, or null when it is complete. */
export function scanStatusNotice(
  scope: string,
  status: 'complete' | 'in-progress' | 'capped' | 'failed',
): RouteTruncation | null {
  if (status === 'complete') return null;
  const reason: LookupReason = status === 'in-progress' ? LOOKUP_IN_PROGRESS : status === 'capped' ? LOOKUP_CAPPED : LOOKUP_UNAVAILABLE;
  return { scope, cap: 0, returned: 0, knownTotal: null, reason };
}

/** True when a response says its history scan is still running and another request will add to it. */
export function isScanInProgress(truncated: ReadonlyArray<{ reason?: unknown }> | undefined | null): boolean {
  return !!truncated && truncated.some((t) => t?.reason === LOOKUP_IN_PROGRESS);
}

/**
 * Build a notice for a lookup that FAILED or was UNAVAILABLE.
 *
 * `lookup-failed`      — the call was made and errored / returned unusable data
 *                        (transient: throttle, 5xx, network). Retryable.
 * `lookup-unavailable` — the capability is absent by configuration, not by luck
 *                        (no archive endpoint configured, provider withdrew the
 *                        free tier). Retrying changes nothing; say so differently.
 */
export function lookupFailureNotice(
  scope: string,
  reason: LookupReason = LOOKUP_FAILED,
): RouteTruncation {
  return { scope, cap: 0, returned: 0, knownTotal: null, reason };
}

/**
 * True for a reason that means "a lookup did not complete" (as opposed to a cap
 * that bound). The ONE definition, shared by the banner wording, the Capital G/L
 * completeness marker and the activity-route cache, so the three cannot drift on
 * what counts as a failed lookup.
 */
export function isLookupFailureReason(reason: unknown): boolean {
  return typeof reason === 'string' && reason.startsWith('lookup-');
}

/** True when at least one notice reports a failed / unavailable lookup. */
export function hasLookupFailure(notices: ReadonlyArray<{ reason: string }>): boolean {
  return notices.some((n) => isLookupFailureReason(n.reason));
}

/** A registry entry: a route truncation plus who reported it. */
export interface TruncationNotice extends RouteTruncation {
  /** Fetcher label, matching PositionsContext's source labels. */
  source: string;
  /** The wallet address the truncated scan ran for. */
  address: string;
}

type Listener = () => void;

const entries = new Map<string, TruncationNotice[]>();
const listeners = new Set<Listener>();

let snapshot: TruncationNotice[] = [];
let snapshotKey = '[]';

function keyFor(source: string, address: string): string {
  return `${source}|${address.toLowerCase()}`;
}

/**
 * Rebuild the public snapshot. The identity ONLY changes when the contents
 * actually change — `useSyncExternalStore` re-renders on every new identity, so
 * returning a fresh array each poll would loop forever.
 */
function rebuild(): void {
  const next: TruncationNotice[] = [];
  for (const list of entries.values()) next.push(...list);
  next.sort((a, b) => (a.source + a.scope).localeCompare(b.source + b.scope));
  const nextKey = JSON.stringify(next);
  if (nextKey === snapshotKey) return;
  snapshot = next;
  snapshotKey = nextKey;
  for (const l of listeners) l();
}

/**
 * Record (or clear) the truncations a route reported for one (source, address).
 *
 * Passing an empty/absent array CLEARS any previous notice for that pair, so a
 * wallet that drops back under the cap — or a route that starts paginating in
 * Phase 2/3 — stops warning without a reload. A FAILED fetch must not call this
 * at all: absence of evidence is not evidence of completeness (queue item B).
 */
export function applyTruncationNotices(
  source: string,
  address: string,
  truncated: RouteTruncation[] | undefined | null,
): void {
  const key = keyFor(source, address);
  if (!truncated || truncated.length === 0) {
    if (entries.delete(key)) rebuild();
    return;
  }
  entries.set(
    key,
    truncated.map((t) => ({ ...t, source, address })),
  );
  rebuild();
}

export function subscribeTruncation(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getTruncationSnapshot(): TruncationNotice[] {
  return snapshot;
}

/** Server snapshot for useSyncExternalStore — never truncated during SSR. */
export function getTruncationServerSnapshot(): TruncationNotice[] {
  return EMPTY;
}

const EMPTY: TruncationNotice[] = [];

/** Test/reset helper. Not used in product code. */
export function resetTruncationNotices(): void {
  entries.clear();
  rebuild();
}

/**
 * One-line human summary of a notice, shared by every surface that renders one
 * so the wording can never drift between dashboard, analytics and lending.
 */
export function describeTruncation(n: TruncationNotice): string {
  const where = n.scope ? `${n.source} · ${n.scope}` : n.source;

  // Queue item C Phase 3 — the Sugar reasons are not "position caps", and
  // saying so would misdescribe what was missed. Each gets its own wording so
  // the notice states the real limit the user ran into.
  switch (n.reason) {
    // Queue item B / ITEM 0i — a FAILED lookup, not a cap. These must be worded
    // as "we could not verify", never as a count, because we do not know the
    // count: that is precisely what failed.
    case LOOKUP_FAILED:
      return `${where}: couldn't verify this right now — some positions and fees may be missing from totals`;
    case LOOKUP_UNAVAILABLE:
      return `${where}: history lookup is unavailable right now — some positions and fees may be missing from totals`;
    case LOOKUP_IN_PROGRESS:
      return `${where}: still reading this wallet's history — more positions and fees will appear as it loads`;
    case LOOKUP_CAPPED:
      return `${where}: this wallet's history is too long to read in full — only its most recent activity is included`;
    case 'pool-scan-ceiling':
      return `${where}: this contract can only scan the first ${n.cap} pools — a position staked in a newer pool would not be listed`;
    case 'page-revert-skipped':
      return `${where}: one pool holds more staked positions than this contract can return at once — some are not listed`;
    case 'page-budget':
      return `${where}: the position scan stopped at its time budget — there may be more`;
  }

  if (n.knownTotal != null && n.knownTotal > n.returned) {
    return `${where}: showing ${n.returned} of ${n.knownTotal} positions (cap ${n.cap})`;
  }
  return `${where}: hit the ${n.cap}-position scan cap — there may be more`;
}
