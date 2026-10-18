// Server-only: add the `store-write-failed` information notice to a route's
// notices when any write to the shared store failed while this request ran
// (batch C 1d). Figures are unaffected — they come from what the request read
// or fetched — but the work was not saved and the next load repeats it.
import { storeWriteFailuresSince } from './sharedStore';
import { storeWriteFailedNotice, type RouteTruncation } from './enumerationTruncation';

export function withStoreWriteNotice(notices: RouteTruncation[], sinceMs: number, scope: string): RouteTruncation[] {
  return storeWriteFailuresSince(sinceMs) > 0 ? [...notices, storeWriteFailedNotice(scope)] : notices;
}
