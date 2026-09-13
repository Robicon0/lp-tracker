"use client";

import { useEffect, useState } from "react";
import { isStableSymbol } from "./calculations";

// Live USD value of a token amount, for DISPLAY ONLY.
//
// Built for the Undeployed Tokens transfer form: "4.2 SUI" says nothing about
// how much money is sitting idle, and the record deliberately stores only the
// token and the count. Nothing here is ever persisted — the preview exists so
// the number the user is typing means something while they type it.
//
// It reuses the SAME price path the rest of CLP Tracker already uses
// (/clp-tracker/api/prices → CoinGecko primary, DeFiLlama backup, curated
// symbol→id map, `unresolved` for anything neither source could price). A
// second fetch path would be a second set of answers for the same question
// (Invariant #6), and would also miss the fallback tier.

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

// Symbol → last answer, so re-opening the modal or flipping between fields
// doesn't re-hit the route for a symbol just priced. `null` price means
// "asked, and neither source knew" — cached too, so a genuinely unpriceable
// token doesn't re-query on every keystroke pause.
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

  // Only the ASYNC answers live in state. Everything the hook can work out
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
        let price: number | null = null;
        try {
          const res = await fetch(
            `/clp-tracker/api/prices?symbols=${encodeURIComponent(symbol)}`,
            { cache: "no-store" },
          );
          if (res.ok) {
            const data = (await res.json()) as {
              prices?: Record<string, number>;
            };
            const p = data.prices?.[symbol];
            // > 0, not just finite: a zero from a price service is a failed
            // lookup wearing a number, and showing it would be the exact
            // "$0.00 for a real token" this must never do.
            if (typeof p === "number" && Number.isFinite(p) && p > 0) price = p;
          }
        } catch {
          // A network failure and "nobody has a price" are the same answer to
          // the user: we don't know. Neither invents a figure.
        }
        if (cancelled) return;
        // Only a definitive answer is cached. A transient failure is left
        // uncached so the next pause retries it rather than pinning the field
        // to "price unavailable" for a minute.
        if (price !== null) spotCache.set(symbol, { price, at: Date.now() });
        setAnswer({ symbol, price });
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
