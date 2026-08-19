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
  if (n.knownTotal != null && n.knownTotal > n.returned) {
    return `${where}: showing ${n.returned} of ${n.knownTotal} positions (cap ${n.cap})`;
  }
  return `${where}: hit the ${n.cap}-position scan cap — there may be more`;
}
