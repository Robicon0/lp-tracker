"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  DEFAULT_SETTINGS,
  getBusinessPnLSettings,
  getClaims,
  getPositions,
  getSettings,
  saveBusinessPnLSettings,
  type BusinessPnLSettings,
} from "../lib/storage";
import {
  calcBusinessPnL,
  calcConvertedFees,
  calcGrowthTarget,
  calcUnconvertedHoldings,
} from "../lib/calculations";
import { SellHoldingModal } from "../components/SellHoldingModal";
import { useHydrated } from "../lib/useHydrated";
import { mergePrices, useTokenPrices } from "../lib/useTokenPrices";
import { normalizeChain, normalizeToken } from "../lib/nameNormalization";
import type { AppSettings, FeeClaim, Position } from "../lib/types";

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const tokenFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

function formatUsd(value: number): string {
  return usdFormatter.format(Number.isFinite(value) ? value : 0);
}

function formatToken(value: number): string {
  return tokenFormatter.format(Number.isFinite(value) ? value : 0);
}

// A needed price can land far outside the 2dp range a dollar total lives in —
// a cheap token with a small holding needs a big number, a large holding needs
// fractions of a cent — so this keeps more precision than formatUsd.
const priceFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

function formatPrice(value: number): string {
  return priceFormatter.format(Number.isFinite(value) ? value : 0);
}

// Per-symbol reward totals for a chain block's footer. One symbol renders as
// "12.5 ETH"; a chain mixing reward tokens renders each on its own line so no
// two different tokens are ever silently added together.
function formatRewardTotals(totals: Map<string, number>): string[] {
  const entries = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return ["—"];
  return entries.map(([sym, amt]) => `${formatToken(amt)} ${sym}`);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function pnlColor(value: number): string {
  if (value > 0) return "text-emerald-400";
  if (value < 0) return "text-rose-400";
  return "text-[var(--foreground)]";
}

function formatUpdatedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "just now";
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const inputClass =
  "block w-full rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--foreground)] placeholder:text-[var(--muted)]/60 [color-scheme:dark] caret-[var(--accent)] focus:border-[var(--accent)] focus:bg-[var(--surface-2)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]";

function claimStatus(claim: FeeClaim): string {
  if (claim.convertedToStable) {
    return `Converted${claim.stableSymbol ? ` → ${claim.stableSymbol}` : ""}`;
  }
  if (claim.token1Amount > 0 && claim.token1Symbol.trim() !== "") {
    return `Still in ${claim.token1Symbol.trim().toUpperCase()}`;
  }
  return "Unconverted";
}

export default function BusinessPnlPage() {
  const [claims, setClaims] = useState<FeeClaim[]>([]);
  // Read only to compute the Growth Target gap below — this page never writes
  // positions or app settings.
  const [positions, setPositions] = useState<Position[]>([]);
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settings, setSettings] = useState<BusinessPnLSettings>({
    prices: {},
    checkpoints: [],
  });
  // Current prices for every reward token seen in claims. Manual entries in
  // settings.prices always override a fetched price (see effectivePrices
  // below), so auto-refresh never clobbers a user value. Shared with the
  // Growth Target card via the hook so both value fees identically.
  const {
    fetchedPrices,
    updatedAt: priceUpdatedAt,
    loading: priceLoading,
    error: priceError,
    refresh: refreshPrices,
  } = useTokenPrices(claims);

  const hydrated = useHydrated(() => {
    setClaims(getClaims());
    setPositions(getPositions());
    setAppSettings(getSettings());
    // Manual prices are keyed by the token symbol shown in the table, which
    // has been normalized (WETH→ETH) since the 2ef8ca5 merge. Overrides saved
    // BEFORE that merge are keyed by the raw symbol, so they have no row to
    // edit and no way to be cleared — invisible and permanent. Fold them onto
    // the canonical key once, on read, keeping an existing canonical value if
    // both exist.
    const stored = getBusinessPnLSettings();
    const prices: Record<string, number> = {};
    let folded = false;
    for (const [token, price] of Object.entries(stored.prices)) {
      const canonical = normalizeToken(token);
      if (canonical !== token) folded = true;
      if (!(canonical in prices)) prices[canonical] = price;
    }
    if (folded) {
      const next = { ...stored, prices };
      saveBusinessPnLSettings(next);
      setSettings(next);
    } else {
      setSettings(stored);
    }
  });

  // Which holding row has the Sell tool open. Null = closed. The modal reads
  // the same `claims` state every figure on this page reads, and hands back the
  // new array on commit, so the whole page recomputes from the written claims.
  const [sellToken, setSellToken] = useState<string | null>(null);

  const persist = (next: BusinessPnLSettings) => {
    setSettings(next);
    saveBusinessPnLSettings(next);
  };

  // Abandon a manual override explicitly: the token goes back to whatever the
  // auto-fetch says. This is the reliable escape hatch — clearing the field
  // works too, but only commits on blur, and a user who pressed Enter instead
  // would previously be left with an empty-looking box that was still applying
  // the stored override. Refresh deliberately never does this (a manual value
  // must survive a refresh), so the revert has to be its own action.
  const resetToAuto = (token: string) => {
    const prices = { ...settings.prices };
    delete prices[token];
    persist({ ...settings, prices });
  };

  // Manual overrides win over fetched prices. Storing a manual value equal to
  // the fetched price is pointless (and would freeze it against future
  // refreshes), so we drop it — clearing the field also reverts to auto.
  const setPrice = (token: string, raw: string) => {
    const prices = { ...settings.prices };
    const value = Number(raw);
    const fetched = fetchedPrices[token];
    const matchesFetched =
      Number.isFinite(fetched) && Math.abs(value - fetched) < 1e-9;
    if (raw.trim() === "" || !Number.isFinite(value) || value <= 0) {
      delete prices[token];
    } else if (matchesFetched) {
      delete prices[token];
    } else {
      prices[token] = value;
    }
    persist({ ...settings, prices });
  };

  // What every calculation and input uses: manual override, else fetched.
  const effectivePrices = useMemo(
    () => mergePrices(fetchedPrices, settings.prices),
    [fetchedPrices, settings.prices],
  );

  const business = useMemo(
    () => calcBusinessPnL(claims, effectivePrices),
    [claims, effectivePrices],
  );

  // Stablecoins are excluded HERE only: this table is about price exposure, and
  // a stablecoin's value is already reported as realized in Converted Fees. The
  // Dashboard and Total P&L "still held" notes keep the unfiltered figure.
  const holdings = useMemo(
    () =>
      calcUnconvertedHoldings(claims, effectivePrices, {
        excludeStables: true,
      }),
    [claims, effectivePrices],
  );

  // The exact figure Overall P&L shows, from the same function — not a second
  // count of realized fees (Invariant #6).
  const convertedFees = useMemo(() => calcConvertedFees(claims), [claims]);

  // How far short of the Growth Target the business currently is. Read from
  // calcGrowthTarget with the same inputs the Growth Target card uses (its fee
  // half is business.allTotal), so the gap here and the "$X behind" there are
  // the same number by construction — nothing is recomputed.
  const growth = useMemo(
    () =>
      calcGrowthTarget(
        positions,
        business.allTotal,
        appSettings.initialCapital,
        appSettings.targetMonthlyPercent,
      ),
    [positions, business.allTotal, appSettings],
  );

  // The gap is now SHARED: every eligible token carries an equal slice of it,
  // and each row's price answers "what does this token need to reach to cover
  // ITS share" — a scenario where they all move together, which is closer to how
  // a portfolio actually behaves than one token carrying the whole thing.
  // Solving share = quantity × (needed − current) gives needed = current +
  // share/quantity. Quantities come from the UNCONVERTED holdings rows, never
  // calcBusinessPnL's lifetime totals — those include reward tokens already
  // converted away, which you can no longer sell into the gap.
  const gapToTarget = growth.cumulativeTarget - growth.combinedEarnings;

  // Eligible = has a price to move from and a quantity to move. A token missing
  // either cannot be solved for, so it is left out of the split entirely rather
  // than silently absorbing a share nothing can deliver.
  const eligibleHoldings = useMemo(
    () =>
      holdings.rows.filter((r) => r.price !== null && r.quantity > 0),
    [holdings.rows],
  );

  // Zero eligible tokens is treated exactly like being at target: there is no
  // row to show a price on, and it keeps the division below safe.
  const gapShare =
    gapToTarget > 0 && eligibleHoldings.length > 0
      ? gapToTarget / eligibleHoldings.length
      : 0;

  const neededPrices = useMemo(() => {
    const out = new Map<string, number>();
    if (!(gapShare > 0)) return out;
    for (const row of eligibleHoldings) {
      out.set(row.token, (row.price as number) + gapShare / row.quantity);
    }
    return out;
  }, [eligibleHoldings, gapShare]);

  // Ledger blocks mirror the sheet's PAIRS blocks, grouped by chain.
  const ledgerBlocks = useMemo(() => {
    const byChain = new Map<string, FeeClaim[]>();
    for (const claim of claims) {
      // Normalized so chain synonyms (SOL/Solana) share one block (Part 5).
      // Grouping only — the claim's stored chain is untouched, and each block's
      // usdTotal is still a plain sum, so no P&L figure changes.
      const chain = normalizeChain(claim.chain) || "OTHER";
      const list = byChain.get(chain);
      if (list) list.push(claim);
      else byChain.set(chain, [claim]);
    }
    const blocks = [...byChain.entries()].map(([chain, list]) => {
      const sorted = [...list].sort((a, b) => {
        const ta = new Date(a.date).getTime();
        const tb = new Date(b.date).getTime();
        return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0);
      });
      let usdTotal = 0;
      // Token/Quote reward totals are summed PER SYMBOL, not as a raw column
      // sum: a chain can hold several pairs with different reward tokens (e.g.
      // ETH and WBTC), and adding those quantities together is meaningless.
      const token1Totals = new Map<string, number>();
      const token2Totals = new Map<string, number>();
      const addTo = (m: Map<string, number>, symbol: string, amount: number) => {
        const s = symbol.trim().toUpperCase();
        if (s === "" || !Number.isFinite(amount) || amount <= 0) return;
        m.set(s, (m.get(s) ?? 0) + amount);
      };
      for (const claim of sorted) {
        if (claim.stableAmount !== null && Number.isFinite(claim.stableAmount)) {
          usdTotal += claim.stableAmount;
        }
        addTo(token1Totals, claim.token1Symbol, claim.token1Amount);
        addTo(token2Totals, claim.token2Symbol, claim.token2Amount);
      }
      return { chain, claims: sorted, usdTotal, token1Totals, token2Totals };
    });
    blocks.sort((a, b) => b.usdTotal - a.usdTotal);
    return blocks;
  }, [claims]);

  if (!hydrated) return null;

  return (
    <section className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          Business P&amp;L
        </h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Fee income by reward token — lifetime quantities, current value, and
          claim-time USD value.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryStat
          label="All Total (Current Value)"
          value={formatUsd(business.allTotal)}
          hint="Reward tokens × current price"
        />
        {/* Renamed from "Usdc Converted": this has always summed EVERY claim's
            claim-time value, converted or not, so the old name described a
            different (smaller) number — the one the next card now shows. The
            figure and its source are unchanged. */}
        <SummaryStat
          label="Total Claimed (Claim-Time Value)"
          value={formatUsd(business.usdcConverted)}
          hint="Σ USD value of all claims when claimed"
        />
        <SummaryStat
          label="Converted Fees (Realized)"
          value={formatUsd(convertedFees)}
          hint="Actually cashed out — the same figure Overall P&L uses"
        />
        <SummaryStat
          label="P&L (Current − Converted)"
          value={formatUsd(business.pnl)}
          valueClass={pnlColor(business.pnl)}
          hint="Positive = holding has done better than cashing out at claim time; negative = worse"
        />
      </div>

      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
        <div className="flex flex-col gap-3 border-b border-[var(--border)] px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold tracking-tight">
              Total Tokens
            </h2>
            <p className="mt-0.5 text-xs text-[var(--muted)]">
              Lifetime reward quantities from all claims. Prices are fetched
              automatically — stablecoins are $1. Type a price to override a
              token manually. A manual price survives Refresh on purpose — use
              &ldquo;Reset to Auto&rdquo; beside it to go back to the fetched
              price.
            </p>
          </div>
          <div className="flex items-center gap-3 whitespace-nowrap">
            <span className="text-xs text-[var(--muted)]">
              {priceLoading
                ? "Updating prices…"
                : priceUpdatedAt
                  ? `Updated ${formatUpdatedAt(priceUpdatedAt)}`
                  : "Prices not fetched yet"}
            </span>
            <button
              type="button"
              onClick={() => void refreshPrices()}
              disabled={priceLoading}
              className="inline-flex h-8 items-center justify-center rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 text-xs font-medium text-[var(--foreground)] transition-colors hover:border-[var(--accent)] disabled:opacity-50"
            >
              Refresh
            </button>
          </div>
        </div>
        {priceError && (
          <p className="border-b border-[var(--border)] px-5 py-2 text-xs text-amber-400">
            ⚠ {priceError} Showing last known / manual prices; you can still
            enter prices by hand.
          </p>
        )}
        {business.tokenRows.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <h3 className="text-base font-semibold tracking-tight">
              No claims yet
            </h3>
            <p className="mx-auto mt-1.5 max-w-sm text-sm text-[var(--muted)]">
              Log fee claims to see your business P&amp;L breakdown.
            </p>
            <Link
              href="/clp-tracker/claims"
              className="mt-4 inline-flex h-9 items-center justify-center rounded-md bg-[var(--accent-solid)] px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[var(--accent-solid)]/90"
            >
              Go to Fee Claims
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-[var(--border)] text-sm">
              <thead className="bg-[var(--surface-2)] text-[11px] uppercase tracking-wider text-[var(--muted)]">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">Token</th>
                  <th className="px-4 py-3 text-right font-medium">Quantity</th>
                  <th className="px-4 py-3 text-right font-medium">
                    Current Price (USD)
                  </th>
                  <th className="px-4 py-3 text-right font-medium">
                    USDC Amount
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {business.tokenRows.map((row) => (
                  <tr key={row.token}>
                    <td className="px-4 py-3 font-medium">{row.token}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatToken(row.quantity)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        {row.token in settings.prices ? (
                          <>
                            <span className="text-[10px] uppercase tracking-wide text-[var(--accent)]">
                              manual
                            </span>
                            <button
                              type="button"
                              onClick={() => resetToAuto(row.token)}
                              title={
                                row.token in fetchedPrices
                                  ? `Discard the manual price and use the fetched price (${formatUsd(fetchedPrices[row.token])})`
                                  : "Discard the manual price (no auto price available for this token)"
                              }
                              className="text-[10px] font-medium text-[var(--muted)] underline decoration-dotted underline-offset-2 transition-colors hover:text-[var(--accent)]"
                            >
                              {row.token in fetchedPrices
                                ? "Reset to Auto"
                                : "Clear"}
                            </button>
                          </>
                        ) : row.token in fetchedPrices ? (
                          <span className="text-[10px] uppercase tracking-wide text-[var(--muted)]">
                            auto
                          </span>
                        ) : null}
                        <input
                          key={`${row.token}-${row.price ?? "na"}`}
                          type="number"
                          step="any"
                          min="0"
                          aria-label={`Current price for ${row.token}`}
                          className={`${inputClass} w-32 text-right`}
                          placeholder="price"
                          defaultValue={row.price ?? ""}
                          // Enter must commit. Without this the field only saved
                          // on blur, so clearing it and pressing Enter left an
                          // empty box while the override was still stored and
                          // still applied — the "stuck on MANUAL" report.
                          // Escape abandons the edit and restores what is shown.
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              e.currentTarget.blur();
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              e.currentTarget.value =
                                row.price === null ? "" : String(row.price);
                              e.currentTarget.blur();
                            }
                          }}
                          onBlur={(e) => setPrice(row.token, e.target.value)}
                        />
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {row.usdValue === null ? (
                        <span className="text-[var(--muted)]">
                          — enter price
                        </span>
                      ) : (
                        formatUsd(row.usdValue)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-[var(--border-strong)] bg-[var(--surface-2)]/60">
                <tr className="font-semibold">
                  <td className="px-4 py-3">All Total</td>
                  <td className="px-4 py-3" />
                  <td className="px-4 py-3" />
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatUsd(business.allTotal)}
                    {business.unpricedTokens.length > 0 && (
                      <span className="ml-2 text-xs font-normal text-amber-400">
                        excludes {business.unpricedTokens.join(", ")}
                      </span>
                    )}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
        <div className="border-b border-[var(--border)] px-5 py-4">
          <h2 className="text-sm font-semibold tracking-tight">
            Unconverted Holdings
          </h2>
          <p className="mt-0.5 text-xs text-[var(--muted)]">
            Reward tokens you claimed but have not cashed out to stablecoin —
            still exposed to price. Cost basis is the claim-time USD value;
            P&amp;L is what you&apos;ve gained or lost by holding instead of
            converting. Uses the same prices entered above. Stablecoin legs are
            not listed: they carry no price exposure and already count as
            realized in Converted Fees.
          </p>
        </div>
        {holdings.rows.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-[var(--muted)]">
            No unconverted holdings — every claim has been cashed out to
            stablecoin.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 border-b border-[var(--border)] px-5 py-4 sm:grid-cols-3">
              <SummaryStat
                label="Current Value"
                value={formatUsd(holdings.totalCurrentValue)}
              />
              <SummaryStat
                label="Cost Basis (Claim-Time)"
                value={formatUsd(holdings.totalCostBasis)}
              />
              <SummaryStat
                label="Unrealized P&L"
                value={formatUsd(holdings.totalPnl)}
                valueClass={pnlColor(holdings.totalPnl)}
              />
            </div>
            <div className="border-b border-[var(--border)] px-5 py-4">
              {/* One line, not a caveat essay: the assumption is the whole point
                  of reading the column, so it has to be visible beside it. */}
              <p className="text-xs text-[var(--muted)]">
                <span className="font-medium text-[var(--foreground)]">
                  Price to Hit Target
                </span>{" "}
                = what each token would have to reach to cover its EQUAL SHARE
                of the Growth Target gap, holding quantities and every other
                number still. A planning estimate, not a forecast — it assumes
                every token below moves at once, each carrying the same dollar
                amount.
              </p>
              {/* The split itself, stated in dollars: without it the per-row
                  prices look arbitrary, since the share they solve for is
                  invisible. */}
              {gapShare > 0 && (
                <p className="mt-2 text-xs text-amber-300">
                  {formatUsd(gapToTarget)} behind target, split evenly across{" "}
                  {eligibleHoldings.length}{" "}
                  {eligibleHoldings.length === 1 ? "token" : "tokens"} —{" "}
                  {formatUsd(gapShare)} each.
                </p>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-[var(--border)] text-sm">
                <thead className="bg-[var(--surface-2)] text-[11px] uppercase tracking-wider text-[var(--muted)]">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">Token</th>
                    <th className="px-4 py-3 text-right font-medium">
                      Quantity Held
                    </th>
                    <th className="px-4 py-3 text-right font-medium">
                      Current Value
                    </th>
                    <th className="px-4 py-3 text-right font-medium">
                      Cost Basis
                    </th>
                    <th className="px-4 py-3 text-right font-medium">
                      Unrealized P&L
                    </th>
                    <th className="px-4 py-3 text-right font-medium">
                      Price to Hit Target
                    </th>
                    <th className="px-4 py-3 text-right font-medium">
                      <span className="sr-only">Sell</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {holdings.rows.map((row) => (
                    <tr key={row.token}>
                      <td className="px-4 py-3 font-medium">{row.token}</td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatToken(row.quantity)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {row.currentValue === null ? (
                          <span className="text-[var(--muted)]">
                            — enter price
                          </span>
                        ) : (
                          formatUsd(row.currentValue)
                        )}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {row.costBasis === null ? (
                          <span className="text-[var(--muted)]">—</span>
                        ) : (
                          formatUsd(row.costBasis)
                        )}
                      </td>
                      <td
                        className={`px-4 py-3 text-right tabular-nums ${
                          row.pnl === null ? "" : pnlColor(row.pnl)
                        }`}
                      >
                        {row.pnl === null ? (
                          <span className="text-[var(--muted)]">—</span>
                        ) : (
                          formatUsd(row.pnl)
                        )}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {gapToTarget <= 0 ? (
                          <span className="text-emerald-400">
                            target already met
                          </span>
                        ) : neededPrices.has(row.token) ? (
                          <span className="text-[var(--foreground)]">
                            {formatPrice(
                              neededPrices.get(row.token) as number,
                            )}
                          </span>
                        ) : (
                          <span className="text-[var(--muted)]">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => setSellToken(row.token)}
                          className="rounded-md border border-[var(--border-strong)] px-2 py-1 text-[11px] font-medium text-[var(--muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
                        >
                          Sell
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t border-[var(--border-strong)] bg-[var(--surface-2)]/60">
                  <tr className="font-semibold">
                    <td className="px-4 py-3">Total</td>
                    <td className="px-4 py-3" />
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatUsd(holdings.totalCurrentValue)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatUsd(holdings.totalCostBasis)}
                    </td>
                    <td
                      className={`px-4 py-3 text-right tabular-nums ${pnlColor(
                        holdings.totalPnl,
                      )}`}
                    >
                      {formatUsd(holdings.totalPnl)}
                    </td>
                    {/* No total: these are alternative single-token scenarios,
                        not parts of one sum — adding them would be meaningless. */}
                    <td className="px-4 py-3" />
                    <td className="px-4 py-3" />
                  </tr>
                </tfoot>
              </table>
            </div>
            {holdings.hasUnknownCostBasis && (
              <p className="border-t border-[var(--border)] px-5 py-3 text-xs text-amber-400">
                ⚠ Some unconverted claims have no recorded USD value, so their
                cost basis is unknown and excluded from the totals above.
              </p>
            )}
            {sellToken !== null && (
              <SellHoldingModal
                token={sellToken}
                availableQuantity={
                  holdings.rows.find((r) => r.token === sellToken)?.quantity ?? 0
                }
                suggestedPrice={
                  holdings.rows.find((r) => r.token === sellToken)?.price ?? null
                }
                claims={claims}
                onCancel={() => setSellToken(null)}
                onCommitted={(next) => {
                  setClaims(next);
                  setSellToken(null);
                }}
              />
            )}
          </>
        )}
      </div>

      {ledgerBlocks.length > 0 && (
        <div className="space-y-6">
          {ledgerBlocks.map((block) => (
            <div
              key={block.chain}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)]"
            >
              <div className="border-b border-[var(--border)] px-5 py-4">
                <h2 className="text-sm font-semibold tracking-tight">
                  {block.chain} Claims
                </h2>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-[var(--border)] text-sm">
                  <thead className="bg-[var(--surface-2)] text-[11px] uppercase tracking-wider text-[var(--muted)]">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium">Date</th>
                      <th className="px-4 py-3 text-left font-medium">Pair</th>
                      <th className="px-4 py-3 text-left font-medium">
                        Platform
                      </th>
                      <th className="px-4 py-3 text-right font-medium">
                        Token Rewards
                      </th>
                      <th className="px-4 py-3 text-right font-medium">
                        Quote Rewards
                      </th>
                      <th className="px-4 py-3 text-right font-medium">
                        USD Value
                      </th>
                      <th className="px-4 py-3 text-left font-medium">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {block.claims.map((claim) => (
                      <tr key={claim.id}>
                        <td className="px-4 py-3 whitespace-nowrap">
                          {formatDate(claim.date)}
                        </td>
                        <td className="px-4 py-3">{claim.pair}</td>
                        <td className="px-4 py-3">{claim.platform}</td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {claim.token1Amount > 0
                            ? `${formatToken(claim.token1Amount)} ${claim.token1Symbol}`
                            : "—"}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {claim.token2Amount > 0
                            ? `${formatToken(claim.token2Amount)} ${claim.token2Symbol}`
                            : "—"}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {claim.stableAmount === null
                            ? "—"
                            : formatUsd(claim.stableAmount)}
                        </td>
                        <td className="px-4 py-3 text-xs text-[var(--muted)]">
                          {claimStatus(claim)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t border-[var(--border-strong)] bg-[var(--surface-2)]/60">
                    <tr className="font-semibold align-top">
                      <td className="px-4 py-3">TOTAL</td>
                      <td className="px-4 py-3" colSpan={2} />
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatRewardTotals(block.token1Totals).map((line) => (
                          <div key={line}>{line}</div>
                        ))}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatRewardTotals(block.token2Totals).map((line) => (
                          <div key={line}>{line}</div>
                        ))}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatUsd(block.usdTotal)}
                      </td>
                      <td className="px-4 py-3" />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

interface SummaryStatProps {
  label: string;
  value: string;
  valueClass?: string;
  hint?: string;
}

function SummaryStat({ label, value, valueClass, hint }: SummaryStatProps) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-5 py-4">
      <p className="text-[11px] uppercase tracking-wider text-[var(--muted)]">
        {label}
      </p>
      <p
        className={`mt-1 text-xl font-semibold tabular-nums ${valueClass ?? ""}`}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-[var(--muted)]">{hint}</p>}
    </div>
  );
}
