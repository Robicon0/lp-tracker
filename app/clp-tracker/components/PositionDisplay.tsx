"use client";

import {
  type RangeHealth,
  type RangeStatus,
} from "../lib/calculations";
import {
  formatPrice,
} from "../lib/positionFormUtils";

export interface TxLinkBadgeProps {
  value: string | null;
}


export function TxLinkBadge({ value }: TxLinkBadgeProps) {
  if (!value) return null;
  const isUrl = /^https?:\/\//i.test(value);
  if (isUrl) {
    return (
      <a
        href={value}
        target="_blank"
        rel="noopener noreferrer"
        title="Open transaction"
        aria-label="Open transaction"
        className="text-[var(--accent)] hover:opacity-80"
        onClick={(e) => e.stopPropagation()}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          className="h-3.5 w-3.5"
          aria-hidden
        >
          <path
            d="M14 4h6v6M20 4l-9 9M10 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </a>
    );
  }
  const hint = value.length > 8 ? `${value.slice(0, 8)}…` : value;
  return (
    <span
      title={value}
      className="font-mono text-[10px] text-[var(--muted)]"
      aria-label={`Transaction ${hint}`}
    >
      {hint}
    </span>
  );
}


export function rangeStatusMeta(status: RangeHealth["status"]): {
  label: string;
  cls: string;
} {
  switch (status) {
    case "safe":
      return {
        label: "In Range",
        cls: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/30",
      };
    case "close":
      return {
        label: "Getting Close",
        cls: "bg-amber-500/10 text-amber-300 ring-amber-500/30",
      };
    case "out":
      return {
        label: "Out of Range",
        cls: "bg-rose-500/10 text-rose-300 ring-rose-500/30",
      };
    default:
      return {
        label: "Price needed",
        cls: "bg-[var(--surface-2)] text-[var(--muted)] ring-[var(--border-strong)]",
      };
  }
}


export function rangeHealthDetail(health: RangeHealth): string {
  if (health.status === "out") {
    return health.distanceToLowerPct !== null && health.distanceToLowerPct < 0
      ? "below range"
      : "above range";
  }
  if (health.nearestEdgePct === null) return "";
  return `${health.nearestEdgePct.toFixed(1)}% to edge`;
}


export function RangeBadge({ status }: { status: RangeHealth["status"] }) {
  const meta = rangeStatusMeta(status);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ring-inset whitespace-nowrap ${meta.cls}`}
    >
      {meta.label}
    </span>
  );
}


export const RANGE_BAR_TONE: Record<RangeStatus, { fill: string; text: string }> = {
  safe: { fill: "bg-emerald-400", text: "text-emerald-300" },
  close: { fill: "bg-amber-400", text: "text-amber-300" },
  out: { fill: "bg-rose-400", text: "text-rose-300" },
  unknown: { fill: "bg-[var(--muted)]", text: "text-[var(--muted)]" },
};


// Where price sits between the range bounds, drawn rather than described.
// bandPosition is 0 at the bottom edge and 1 at the top; it runs outside that
// when a position has drifted out of range, so the marker is clamped to the
// track and the caption carries the real distance.
export function RangeBar({
  health,
  entryPrice,
  rangeDown,
  rangeUp,
}: {
  health: RangeHealth;
  entryPrice: number;
  rangeDown: number;
  rangeUp: number;
}) {
  const span = rangeUp - rangeDown;
  const tone = RANGE_BAR_TONE[health.status];
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const pricePct =
    health.bandPosition === null ? null : clamp(health.bandPosition) * 100;
  const entryPct = span > 0 ? clamp((entryPrice - rangeDown) / span) * 100 : null;

  return (
    <div className="mt-3">
      <div className="relative h-1.5 rounded-full bg-[var(--surface-2)]">
        {entryPct !== null && (
          <span
            className="absolute top-1/2 h-3 w-px -translate-x-1/2 -translate-y-1/2 bg-[var(--muted)]/70"
            style={{ left: `${entryPct}%` }}
            aria-hidden
          />
        )}
        {pricePct !== null && (
          <span
            className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-[var(--surface)] ${tone.fill}`}
            style={{ left: `${pricePct}%` }}
            aria-hidden
          />
        )}
      </div>
      <div className="mt-1.5 flex items-baseline justify-between gap-2 text-[11px] tabular-nums text-[var(--muted)]">
        <span>{formatPrice(rangeDown)}</span>
        <span className={tone.text}>{rangeHealthDetail(health)}</span>
        <span>{formatPrice(rangeUp)}</span>
      </div>
    </div>
  );
}


// One metric in the card's grid. Kept tiny so the grid stays declarative.
export function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div>
      <dt className="text-[10px] font-medium uppercase tracking-wider text-[var(--muted)]">
        {label}
      </dt>
      <dd
        className={`mt-0.5 text-sm tabular-nums ${tone ?? "text-[var(--foreground)]"}`}
      >
        {value}
      </dd>
    </div>
  );
}
