"use client";

import { useTruncationNotices } from "../hooks/useTruncationNotices";
import { describeTruncation } from "../lib/enumerationTruncation";

/**
 * Renders the enumeration-truncation notice (queue item C, Phase 1).
 *
 * Renders NOTHING when every scan was complete — which is the case for every
 * wallet below every cap, i.e. essentially all of them today. It appears only
 * when a hardcoded cap actually bound this load, and then it says which source,
 * how many positions are showing, and how many exist where that is knowable.
 *
 * Deliberately styled as a WARNING rather than an error: the positions that DID
 * load are correct, the total is simply incomplete. Same honesty contract as
 * the Capital G/L "≈ approximate" marker — a partial figure must never present
 * itself as a complete one.
 */
export function TruncationBanner({ style }: { style?: React.CSSProperties }) {
  const notices = useTruncationNotices();
  if (notices.length === 0) return null;

  const anyKnown = notices.some((n) => n.knownTotal != null && n.knownTotal > n.returned);
  const missing = notices.reduce(
    (sum, n) => sum + (n.knownTotal != null ? Math.max(0, n.knownTotal - n.returned) : 0),
    0,
  );

  return (
    <div
      role="status"
      style={{
        border: "1px solid var(--warn)",
        background: "color-mix(in srgb, var(--warn) 10%, transparent)",
        color: "var(--foreground)",
        padding: "10px 14px",
        fontSize: 12,
        lineHeight: 1.6,
        letterSpacing: "0.03em",
        ...style,
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 4 }}>
        ⚠ Some positions could not be listed
        {anyKnown && missing > 0 ? ` — ${missing} not shown` : ""}
      </div>
      <div style={{ opacity: 0.85 }}>
        A scan limit was reached, so the positions below and every total computed
        from them are incomplete:
      </div>
      <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
        {notices.map((n) => (
          <li key={`${n.source}|${n.scope}|${n.address}`}>{describeTruncation(n)}</li>
        ))}
      </ul>
    </div>
  );
}
