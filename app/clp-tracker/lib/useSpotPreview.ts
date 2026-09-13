"use client";

import { useCallback, useEffect, useState } from "react";
import { isStableSymbol } from "./calculations";

// Current USD spot prices for token symbols, for DISPLAY ONLY.
//
// Two consumers, ONE path — that is the whole point of this module:
//   • useSpotPreview  — the "≈ $X USD" line in the Add/Edit Transfer modal,
//     debounced because it reacts to typing.
//   • useSpotPrices   — the Transfers-by-Chain list, which values every
//     non-stable Undeployed Tokens row and its chain subtotal.
// They share `spotCache` and `fetchSpot`, so the figure a row shows and the
// figure the modal previews for the same token can never disagree, and a
// symbol priced by one is free for the other (Invariant #6).
//
// The underlying request is /clp-tracker/api/prices — the same route
// useTokenPrices (Business P&L, Growth Target) already uses, so this inherits
// its CoinGecko-primary → DeFiLlama-backup tiering and the curated symbol→id
// map. Nothing here fetches a price any other way.
//
// NOTE: nothing in this module is ever persisted to a transfer record. These
// are live display values; the records keep storing token + count.

export type SpotPreview =
  // Not enough typed yet, or the token is a stablecoin: nothing to show. A
  // stablecoin needs no lookup — the Amount field ALREADY reads as dollars,
  // so "100 USDC ≈ $100.00" is a restatement, not information.
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; usd: number; price: number }
  // Priced by neither source. Shown as "price unavailable" — NEVER as $0.00,
  // which would read as "this token is worthless" rather than "we don't know"
  // (pricing-invariants: a missing number is surfaced, never fabricated).
  | { status: "unavailable" };

// Symbol → last answer. `price: null` means "asked, and neither source knew" —
// cached too, so a genuinely unpriceable token doesn't re-query endlessly.
const spotCache = new Map<string, { price: number | null; at: number }>();
const TTL_MS = 60_000;

// Long enough that ordinary typing never fires a request, short enough that
// the value appears while the user is still looking at the field.
const DEBOUNCE_MS = 400;

function cached(symbol: string): { price: number | null } | null {
  const hit = spotCache.get(symbol);
  if (!hit || Date.now() - hit.at >= TTL_MS) return null;
  return hit;
}

function normalizeSymbols(symbols: string[]): string[] {
  return [
    ...new Set(symbols.map((s) => s.trim().toUpperCase()).filter((s) => s)),
  ].sort();
}

// Symbols with a request already in the air. Without this, two consumers that
// ask before the first response lands (the list hydrating in two passes, or
// the list and the modal at once) each fire their own request for the same
// symbol — measured: 4 requests where 2 would do. In-flight dedup is a
// standing requirement in this codebase for exactly that reason; here it also
// collapses React's development double-effect into one call.
const inflight = new Map<string, Promise<void>>();

// One request for however many symbols are missing — the route takes a
// comma-separated list, so a list of twenty rows is still a single round-trip.
// Writes straight into spotCache and returns nothing; callers re-read the
// cache. A DEFINITIVE answer (priced, or asked-and-unknown) is cached; a
// transport failure is NOT, so the next attempt retries rather than pinning
// every row to "price unavailable" for a minute.
async function fetchSpot(symbols: string[]): Promise<void> {
  const needed = symbols.filter((s) => !cached(s));
  const waits: Promise<void>[] = [];
  const fresh: string[] = [];
  for (const symbol of needed) {
    const pending = inflight.get(symbol);
    if (pending) waits.push(pending);
    else fresh.push(symbol);
  }
  if (fresh.length > 0) {
    const run = requestSpot(fresh).finally(() => {
      for (const symbol of fresh) inflight.delete(symbol);
    });
    for (const symbol of fresh) inflight.set(symbol, run);
    waits.push(run);
  }
  await Promise.all(waits);
}

async function requestSpot(symbols: string[]): Promise<void> {
  if (symbols.length === 0) return;
  let prices: Record<string, number> = {};
  try {
    const res = await fetch(
      `/clp-tracker/api/prices?symbols=${encodeURIComponent(symbols.join(","))}`,
      { cache: "no-store" },
    );
    if (!res.ok) return;
    const data = (await res.json()) as { prices?: Record<string, number> };
    prices = data.prices ?? {};
  } catch {
    // A network failure and "nobody has a price" are the same answer to the
    // user — we don't know — but only the latter is a fact worth caching.
    return;
  }
  const at = Date.now();
  for (const symbol of symbols) {
    const p = prices[symbol];
    // > 0, not just finite: a zero from a price service is a failed lookup
    // wearing a number, and storing it would be the exact "$0.00 for a real
    // token" this must never show.
    const ok = typeof p === "number" && Number.isFinite(p) && p > 0;
    spotCache.set(symbol, { price: ok ? p : null, at });
  }
}

// ---------------------------------------------------------------------------
// Single symbol, debounced — the transfer form's live preview.
// ---------------------------------------------------------------------------

export function useSpotPreview(
  token: string,
  amount: string,
  enabled: boolean,
): SpotPreview {
  const symbol = token.trim().toUpperCase();
  const value = Number(amount);
  const ready =
    enabled &&
    symbol !== "" &&
    amount.trim() !== "" &&
    Number.isFinite(value) &&
    value !== 0;
  // A stablecoin is answered without asking anyone: it needs no lookup, and
  // returning early here is also what keeps the effect below from firing.
  const stable = ready && isStableSymbol(symbol);

  // Only the ASYNC answer lives in state. Everything the hook can work out
  // synchronously (not ready, stablecoin, already cached) is derived during
  // render instead — a setState in an effect body for those would be a
  // cascading render for a value that was known before the render started.
  const [answer, setAnswer] = useState<{
    symbol: string;
    price: number | null;
  } | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    if (!ready || stable) return;
    if (cached(symbol)) return;

    // `cancelled` rather than only clearing the timer: the fetch can still be
    // in flight when the symbol changes, and a late response must not
    // overwrite the newer one's answer.
    let cancelled = false;
    const timer = setTimeout(() => {
      setPending(symbol);
      void (async () => {
        await fetchSpot([symbol]);
        if (cancelled) return;
        setAnswer({ symbol, price: cached(symbol)?.price ?? null });
        setPending(null);
      })();
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [symbol, ready, stable]);

  if (!ready || stable) return { status: "idle" };

  // The cache first, then this render's own resolved answer. Both are keyed by
  // symbol so a stale answer from the previously-typed token can never be
  // shown against the current one.
  const hit = cached(symbol) ?? (answer?.symbol === symbol ? answer : null);
  if (hit) {
    return hit.price === null
      ? { status: "unavailable" }
      : { status: "ok", usd: value * hit.price, price: hit.price };
  }
  // Amount-only edits re-derive from the cached price above without a refetch,
  // so `pending` covers just the genuinely-unanswered case.
  return pending === symbol ? { status: "loading" } : { status: "idle" };
}

// ---------------------------------------------------------------------------
// Many symbols at once — the transfer list.
// ---------------------------------------------------------------------------

// `undefined` = not answered yet (still loading); `null` = asked, unpriceable;
// a number = the current spot price. The three are deliberately distinct: a
// list must be able to say "working on it" without ever saying "$0".
export type SpotPriceLookup = (symbol: string) => number | null | undefined;

export function useSpotPrices(symbols: string[]): SpotPriceLookup {
  const wanted = normalizeSymbols(symbols);
  // A plain string, so the effect fires when the SET changes rather than on
  // every render (the caller rebuilds the array each time).
  const key = wanted.join(",");

  // The answers live in the shared module cache, not in state — state here is
  // only a signal that the cache has new content worth re-rendering for. This
  // is what lets a symbol priced by the modal show up instantly in the list.
  const [version, bump] = useState(0);

  useEffect(() => {
    if (key === "") return;
    const missing = key.split(",").filter((s) => !cached(s));
    if (missing.length === 0) return;
    let cancelled = false;
    void (async () => {
      await fetchSpot(missing);
      if (!cancelled) bump((n) => n + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [key]);

  // Stable across renders that changed neither the requested set nor the cache
  // contents, so callers can safely use it as a useMemo dependency — an
  // identity that changed every render would quietly defeat their memo.
  return useCallback(
    (symbol: string) => {
      const hit = cached(symbol.trim().toUpperCase());
      return hit ? hit.price : undefined;
    },
    // `key` and `version` are deliberately listed even though the body does
    // not reference them: the answers live in a MODULE cache the linter cannot
    // see, and these two are the only things that can change what it returns
    // (a new symbol set, or a fetch that landed). Dropping them would freeze
    // the identity and leave the caller's memo holding pre-fetch answers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, version],
  );
}
