"use client";

import { calcClaimTokenTotals } from "../lib/calculations";
import type { FeeClaim } from "../lib/types";
import { formatUsd } from "../lib/positionFormUtils";

// Claim display pieces shared by the Fee Claims page and the position detail
// page, moved verbatim from claims/page.tsx so a claim renders — and a list of
// claims totals and sorts — identically in both places.

export const tokenFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

export function formatToken(value: number): string {
  return tokenFormatter.format(Number.isFinite(value) ? value : 0);
}

export function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatDateDDMMYYYY(value: string): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

// The Fee Claims page's sort: newest first, an unparseable date sorting as 0
// (oldest). The detail page lists one position's claims in the same order the
// Fee Claims page shows them when filtered to that position.
export function compareClaimsByDateDesc(a: FeeClaim, b: FeeClaim): number {
  const ta = new Date(a.date).getTime();
  const tb = new Date(b.date).getTime();
  const safeA = Number.isFinite(ta) ? ta : 0;
  const safeB = Number.isFinite(tb) ? tb : 0;
  return safeB - safeA;
}

// Totals by token for the visible claims. Two things are kept visibly apart:
// a token's raw claimed quantity (never reduced by conversions) and the
// stablecoin its CONVERTED claims became. A pool's native stablecoin (the USDC
// side of SUI/USDC) gets its own row labelled as earned-as-stablecoin, and
// never absorbs conversion proceeds — those sit under the token that was sold.
export function ClaimTokenTotalsFooter({
  totals,
  claimCount,
}: {
  totals: ReturnType<typeof calcClaimTokenTotals>;
  claimCount: number;
}) {
  return (
    <div className="border-t border-[var(--border-strong)] bg-[var(--surface-2)]/40 px-5 py-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
          Totals by token
        </h3>
        <span className="text-[11px] text-[var(--muted)]">
          Across the {claimCount} {claimCount === 1 ? "claim" : "claims"} shown
          above
        </span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {totals.tokens.map((t) => (
          <div
            key={t.symbol}
            data-token-total={t.symbol}
            className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5"
          >
            <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
              Total {t.symbol} claimed
            </div>
            <div className="mt-0.5 text-base font-semibold tabular-nums text-[var(--foreground)]">
              {formatToken(t.claimed)} {t.symbol}
            </div>
            <div className="text-[11px] text-[var(--muted)]">
              {t.isStable
                ? `Earned directly as ${t.symbol} in the pool · ${t.claimCount} ${t.claimCount === 1 ? "claim" : "claims"}`
                : `${t.claimCount} ${t.claimCount === 1 ? "claim" : "claims"} · before any conversion`}
            </div>
            {/* Proceeds of converting OTHER tokens into this stablecoin. A
                separate figure from the pool-earned total above — never
                summed into it. */}
            {t.isStable && t.convertedIn && t.convertedIn.value > 0 && (
              <div
                data-converted-in={t.symbol}
                className="mt-2 border-t border-[var(--border)] pt-2 text-[12px]"
              >
                <span className="text-[var(--muted)]">
                  Converted from other tokens:
                </span>{" "}
                <span className="font-semibold tabular-nums text-[var(--foreground)]">
                  {formatUsd(t.convertedIn.value)}
                </span>
                <div className="text-[10px] text-[var(--muted)]">
                  From {t.convertedIn.claimCount} converted{" "}
                  {t.convertedIn.claimCount === 1 ? "claim" : "claims"} across{" "}
                  {t.convertedIn.fromTokens.join(", ")}
                </div>
              </div>
            )}
            {!t.isStable && t.convertedQuantity > 0 && (
              <div
                data-converted-qty={t.symbol}
                className="mt-2 border-t border-[var(--border)] pt-2 text-[12px]"
              >
                <div>
                  <span className="text-[var(--muted)]">Converted:</span>{" "}
                  <span className="font-semibold tabular-nums text-[var(--foreground)]">
                    {formatToken(t.convertedQuantity)} {t.symbol}
                  </span>{" "}
                  <span className="text-[var(--muted)]">
                    · {t.convertedClaimCount}{" "}
                    {t.convertedClaimCount === 1 ? "claim" : "claims"}
                  </span>
                </div>
                <div data-still-held={t.symbol}>
                  <span className="text-[var(--muted)]">
                    Still held (not yet converted):
                  </span>{" "}
                  <span className="font-semibold tabular-nums text-[var(--foreground)]">
                    {formatToken(t.unconvertedQuantity)} {t.symbol}
                  </span>
                </div>
              </div>
            )}
            {t.converted.map((g) => (
              <div
                key={g.stableSymbol}
                data-converted-to={g.stableSymbol}
                className="mt-2 border-t border-[var(--border)] pt-2 text-[12px]"
              >
                <span className="text-[var(--muted)]">
                  Converted to {g.stableSymbol}:
                </span>{" "}
                <span className="font-semibold tabular-nums text-[var(--foreground)]">
                  {formatUsd(g.value)}
                </span>
                <div className="text-[10px] text-[var(--muted)]">
                  Actual amount received from {g.claimCount} converted{" "}
                  {t.symbol} {g.claimCount === 1 ? "claim" : "claims"}
                </div>
              </div>
            ))}
            {t.unvaluedConverted > 0 && (
              <div className="mt-2 text-[10px] text-amber-300">
                {t.unvaluedConverted} converted{" "}
                {t.unvaluedConverted === 1 ? "claim has" : "claims have"} no USD
                value — not included above
              </div>
            )}
          </div>
        ))}
      </div>
      {totals.unattributableConverted > 0 && (
        <p className="mt-3 text-[11px] text-amber-300">
          {totals.unattributableConverted} converted{" "}
          {totals.unattributableConverted === 1 ? "claim has" : "claims have"} two
          non-stable tokens, so the proceeds can&apos;t be assigned to one token
          and are left out of the converted lines.
        </p>
      )}
    </div>
  );
}

export interface TxCellProps {
  value: string | null;
}

export function TxCell({ value }: TxCellProps) {
  if (!value) return <span>—</span>;
  const isUrl = /^https?:\/\//i.test(value);
  if (isUrl) {
    return (
      <a
        href={value}
        target="_blank"
        rel="noopener noreferrer"
        // The arrow is part of the label, not a separate word: without this the
        // Tx column breaks "Open" and "↗" onto two lines the moment the table
        // is at all tight, which reads as a clipped cell. Costs ~16px of column
        // min-width and keeps the label intact at every width.
        className="whitespace-nowrap text-[var(--accent)] hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        Open ↗
      </a>
    );
  }
  const display = value.length > 8 ? `${value.slice(0, 8)}…` : value;
  return <span className="font-mono text-xs" title={value}>{display}</span>;
}
