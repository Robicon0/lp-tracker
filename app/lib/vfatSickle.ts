// Client-side wrapper for vfat Sickle resolution.
//
// Mirrors the other app/lib/*.ts fetch wrappers: thin, never throws, returns an
// empty list on any failure so a vfat outage can never blank the dashboard.

export interface SickleRef {
  chain: string;
  address: string;
}

/**
 * Resolve an EOA's deployed vfat Sickle sub-accounts.
 *
 * Returns [] for the overwhelmingly common case of a non-vfat user, and [] on
 * any error — callers union the result into the fetch address set, so an empty
 * result simply means "nothing extra to scan".
 */
export async function fetchVfatSickles(owner: string): Promise<SickleRef[]> {
  if (!owner) return [];
  try {
    const res = await fetch(`/api/vfat/sickles?owner=${encodeURIComponent(owner)}`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.sickles) ? (data.sickles as SickleRef[]) : [];
  } catch {
    return [];
  }
}
