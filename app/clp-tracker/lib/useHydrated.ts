"use client";

import { useEffect, useState } from "react";

// Runs `load` once on mount to hydrate client state from localStorage, then
// flips to true. Centralizes the mount-hydration pattern every page used to
// duplicate independently.
export function useHydrated(load: () => void): boolean {
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    load();
    // Reads from localStorage (an external system) on mount, so this is
    // exactly the effect pattern React's docs endorse — the lint rule can't
    // tell mount-time storage sync apart from a render-triggered cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHydrated(true);
    // Intentionally mount-only: `load` is recreated every render by callers
    // that don't wrap it in useCallback, so including it would hydrate on
    // every render instead of once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return hydrated;
}
