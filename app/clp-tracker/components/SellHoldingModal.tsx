"use client";

import { useMemo, useState } from "react";
import { saveClaims } from "../lib/storage";
import { applyTokenSale, planTokenSale } from "../lib/calculations";
import type { FeeClaim } from "../lib/types";
import { ModalShell } from "./ClaimFormModal";

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

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

function formatUsd(value: number): string {
  return usdFormatter.format(Number.isFinite(value) ? value : 0);
}

function formatToken(value: number): string {
  return tokenFormatter.format(Number.isFinite(value) ? value : 0);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateFormatter.format(d);
}

const inputClass =
  "block w-full rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 py-2 text-sm tabular-nums text-[var(--foreground)] [color-scheme:dark] focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]";

/**
 * Convert an unconverted holding to stablecoin, oldest claim first.
 *
 * The plan the PREVIEW renders and the plan CONFIRM writes are the same object
 * from one `planTokenSale` call — the preview cannot describe one outcome and
 * the commit produce another. Nothing is written until Confirm.
 */
export function SellHoldingModal({
  token,
  availableQuantity,
  suggestedPrice,
  claims,
  onCancel,
  onCommitted,
}: {
  token: string;
  availableQuantity: number;
  // The price already on screen for this row, as a starting point. The user
  // types what they actually sold at — a sale price is a fact, not a quote.
  suggestedPrice: number | null;
  claims: FeeClaim[];
  onCancel: () => void;
  onCommitted: (next: FeeClaim[]) => void;
}) {
  const [amount, setAmount] = useState("");
  const [price, setPrice] = useState(
    suggestedPrice !== null && suggestedPrice > 0 ? String(suggestedPrice) : "",
  );
  const [confirming, setConfirming] = useState(false);

  const amountNum = Number(amount);
  const priceNum = Number(price);
  const amountEntered = amount.trim() !== "" && Number.isFinite(amountNum);
  const priceEntered = price.trim() !== "" && Number.isFinite(priceNum);
  const liveProceeds =
    amountEntered && priceEntered ? amountNum * priceNum : null;

  const plan = useMemo(
    () => planTokenSale(claims, token, amountNum, priceNum),
    [claims, token, amountNum, priceNum],
  );

  // Only surface a validation message once there is something to validate, so
  // an untouched form is not shouting before the user has typed.
  const showError =
    (amountEntered || priceEntered) && plan.error !== null ? plan.error : null;
  const ready = plan.error === null && plan.claims.length > 0;

  const commit = () => {
    const next = applyTokenSale(claims, plan);
    saveClaims(next);
    onCommitted(next);
  };

  const soldTotal = plan.claims.reduce((s, c) => s + c.soldQuantity, 0);
  const usdTotal = plan.claims.reduce((s, c) => s + c.stableAmount, 0);
  const carriedTotal = plan.claims.reduce(
    (s, c) => s + c.stableAlreadyRealized,
    0,
  );

  return (
    <ModalShell title={`Sell ${token}`} onCancel={onCancel}>
      {!confirming ? (
        <div className="space-y-4 px-5 py-5">
          <p className="text-xs text-[var(--muted)]">
            Marks your oldest unconverted {token} claims as converted, in date
            order, splitting the last one if the amount lands mid-claim. You
            hold{" "}
            <span className="font-medium tabular-nums text-[var(--foreground)]">
              {formatToken(availableQuantity)} {token}
            </span>
            .
          </p>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="sell-amount"
                className="block text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]"
              >
                Amount sold ({token})
              </label>
              <input
                id="sell-amount"
                type="number"
                step="any"
                min="0"
                autoFocus
                className={`mt-1.5 ${inputClass}`}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="1.27229"
              />
              <button
                type="button"
                onClick={() => setAmount(String(availableQuantity))}
                className="mt-1.5 text-[11px] font-medium text-[var(--muted)] transition-colors hover:text-[var(--accent)]"
              >
                Sell everything ({formatToken(availableQuantity)})
              </button>
            </div>

            <div>
              <label
                htmlFor="sell-price"
                className="block text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]"
              >
                Price per token (USD)
              </label>
              <input
                id="sell-price"
                type="number"
                step="any"
                min="0"
                className={`mt-1.5 ${inputClass}`}
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="850"
              />
            </div>
          </div>

          <div className="rounded-md border border-[var(--border)] bg-[var(--surface-2)]/60 px-4 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[11px] uppercase tracking-wider text-[var(--muted)]">
                Total proceeds
              </span>
              <span className="text-lg font-semibold tabular-nums text-[var(--foreground)]">
                {liveProceeds === null ? "—" : formatUsd(liveProceeds)}
              </span>
            </div>
            {liveProceeds !== null && (
              <p className="mt-1 text-[11px] tabular-nums text-[var(--muted)]">
                {formatToken(amountNum)} {token} × {formatUsd(priceNum)}
              </p>
            )}
          </div>

          {showError !== null && (
            <p className="text-xs text-rose-400">{showError}</p>
          )}

          <div className="flex justify-end gap-2 border-t border-[var(--border)] pt-4">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md border border-[var(--border-strong)] px-3 py-1.5 text-sm text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!ready}
              onClick={() => setConfirming(true)}
              className="rounded-md bg-[var(--accent-solid)] px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-solid)]/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Preview sale
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4 px-5 py-5">
          <p className="text-xs text-[var(--muted)]">
            Selling{" "}
            <span className="font-medium tabular-nums text-[var(--foreground)]">
              {formatToken(plan.amountSold)} {token}
            </span>{" "}
            at {formatUsd(plan.pricePerToken)} ={" "}
            <span className="font-medium tabular-nums text-[var(--foreground)]">
              {formatUsd(plan.totalProceeds)}
            </span>
            . These {plan.claims.length}{" "}
            {plan.claims.length === 1 ? "claim" : "claims"} will change.
            Nothing is written until you confirm.
          </p>

          <div className="overflow-x-auto rounded-md border border-[var(--border)]">
            <table className="min-w-full divide-y divide-[var(--border)] text-sm">
              <thead className="bg-[var(--surface-2)] text-[11px] uppercase tracking-wider text-[var(--muted)]">
                <tr>
                  <th className="px-3 py-2.5 text-left font-medium">Date</th>
                  <th className="px-3 py-2.5 text-left font-medium">Pair</th>
                  <th className="px-3 py-2.5 text-right font-medium">
                    Current Amount
                  </th>
                  <th className="px-3 py-2.5 text-right font-medium">Selling</th>
                  <th className="px-3 py-2.5 text-left font-medium">Action</th>
                  <th className="px-3 py-2.5 text-right font-medium">
                    New USD Value
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {plan.claims.map((c) => (
                  <tr key={c.claimId} className="align-top">
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      {formatDate(c.date)}
                    </td>
                    <td className="px-3 py-2.5">{c.pair}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {formatToken(c.availableQuantity)} {c.symbol}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {formatToken(c.soldQuantity)}
                    </td>
                    <td className="px-3 py-2.5">
                      {c.isSplit ? (
                        <>
                          <span className="text-amber-300">Split</span>
                          <span className="block text-[11px] text-[var(--muted)]">
                            {formatToken(c.remainingQuantity)} {c.symbol} stays
                            unconverted
                            {c.remainderStableAmount !== null && (
                              <>
                                {" "}
                                (claim-time value{" "}
                                {formatUsd(c.remainderStableAmount)}
                                {c.remainderStableUnchanged ? ", unchanged" : ""}
                                )
                              </>
                            )}
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="text-emerald-400">
                            Convert in full
                          </span>
                          {c.stableAlreadyRealized > 0 && (
                            <span className="block text-[11px] text-[var(--muted)]">
                              includes {formatUsd(c.stableAlreadyRealized)}{" "}
                              stablecoin already counted as realized
                            </span>
                          )}
                        </>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {formatUsd(c.stableAmount)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-[var(--border-strong)] bg-[var(--surface-2)]/60">
                <tr className="font-semibold">
                  <td className="px-3 py-2.5" colSpan={3}>
                    Total
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {formatToken(soldTotal)}
                  </td>
                  <td className="px-3 py-2.5" />
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {formatUsd(usdTotal)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {carriedTotal > 0 && (
            <p className="text-[11px] text-[var(--muted)]">
              {formatUsd(usdTotal)} = {formatUsd(plan.totalProceeds)} of sale
              proceeds + {formatUsd(carriedTotal)} of stablecoin these claims
              were already contributing as realized. Converted Fees rises by the
              sale proceeds alone.
            </p>
          )}

          <div className="flex justify-end gap-2 border-t border-[var(--border)] pt-4">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-md border border-[var(--border-strong)] px-3 py-1.5 text-sm text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
            >
              Back
            </button>
            <button
              type="button"
              onClick={commit}
              className="rounded-md bg-[var(--accent-solid)] px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-solid)]/90"
            >
              Confirm sale
            </button>
          </div>
        </div>
      )}
    </ModalShell>
  );
}
