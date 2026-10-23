"use client";

import { useTruncationNotices } from "../hooks/useTruncationNotices";
import { describeTruncation, isInfoReason, isLookupFailureReason, isUnsupportedReason, unsupportedSummary } from "../lib/enumerationTruncation";

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
  const all = useTruncationNotices();
  // Information lines (pool statistics not loaded) are not "something is
  // missing from the totals" and must not borrow that heading.
  const info = all.filter((n) => isInfoReason(n.reason));
  const notices = all.filter((n) => !isInfoReason(n.reason));
  const infoBlock = info.length === 0 ? null : (
    <div
      role="status"
      data-info-notice
      style={{ border: "1px solid var(--line)", color: "var(--fg-muted)", padding: "8px 14px", fontSize: 12, lineHeight: 1.6, letterSpacing: "0.03em", ...(notices.length === 0 ? style : { marginTop: 8 }) }}
    >
      {info.map((n) => (
        <div key={`${n.source}|${n.scope}|${n.address}`}>ⓘ {describeTruncation(n)}</div>
      ))}
    </div>
  );
  if (notices.length === 0) return infoBlock;

  // A cap and a failed lookup share this banner but are different events, and
  // the heading must not describe one as the other: "a scan limit was reached"
  // is false when the lookup simply did not answer.
  const failures = notices.filter((n) => isLookupFailureReason(n.reason)).length;
  const unsupported = notices.filter((n) => isUnsupportedReason(n.reason));
  const caps = notices.length - failures - unsupported.length;
  const kind =
    caps === 0 && failures === 0 ? "unsupported"
    : failures === 0 ? "cap"
    : failures === notices.length - unsupported.length ? "lookup" : "mixed";
  const heading =
    kind === "unsupported" ? "Some positions can't be read yet"
    : kind === "cap" ? "Some positions could not be listed"
    : kind === "lookup" ? "Some history could not be loaded"
    : "Some positions or history could not be loaded";
  const lead =
    kind === "unsupported"
      ? "This wallet holds positions DefiDesh does not read yet, so they are not in any total:"
      : kind === "cap"
      ? "A scan limit was reached, so the positions below and every total computed from them are incomplete:"
      : kind === "lookup"
        ? "A lookup did not complete, so closed positions, fees and every total computed from them may be incomplete:"
        : "A scan limit was reached and a lookup did not complete, so the positions below and every total computed from them are incomplete:";

  const anyKnown = notices.some((n) => n.knownTotal != null && n.knownTotal > n.returned);
  const missing = notices.reduce(
    (sum, n) => sum + (n.knownTotal != null ? Math.max(0, n.knownTotal - n.returned) : 0),
    0,
  );

  // One compact line in plain words (batch D 1a); the full technical text is
  // one click away, never removed. "Aerodrome (Base) positions may be incomplete".
  const what = (n: { source: string; scope?: string }) => (n.scope ? `${n.source} (${n.scope})` : n.source);
  const capSources = [...new Set(notices.filter((n) => !isLookupFailureReason(n.reason) && !isUnsupportedReason(n.reason)).map(what))];
  const lookupSources = [...new Set(notices.filter((n) => isLookupFailureReason(n.reason)).map((n) => n.source))];
  const summary = [
    ...unsupported.map(unsupportedSummary),
    capSources.length ? `${capSources.join(", ")} positions may be incomplete` : null,
    lookupSources.length ? `${lookupSources.join(", ")} history may be incomplete` : null,
  ].filter(Boolean).join(" · ");

  return (
    <>
    <details
      role="status"
      data-truncation-banner
      style={{
        border: "1px solid var(--warn)",
        background: "color-mix(in srgb, var(--warn) 10%, transparent)",
        color: "var(--foreground)",
        padding: "6px 12px",
        fontSize: 12,
        lineHeight: 1.6,
        letterSpacing: "0.03em",
        ...style,
      }}
    >
      <summary style={{ cursor: "pointer", listStyle: "none", display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700 }}>⚠ {summary}{anyKnown && missing > 0 ? ` — ${missing} not shown` : ""}</span>
        <span style={{ color: "var(--fg-muted)", textDecoration: "underline" }}>details</span>
      </summary>
      <div style={{ marginTop: 6 }}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>{heading}</div>
        <div>{lead}</div>
        <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
          {notices.map((n) => (
            <li key={`${n.source}|${n.scope}|${n.address}`}>{describeTruncation(n)}</li>
          ))}
        </ul>
      </div>
    </details>
    {infoBlock}
    </>
  );
}
