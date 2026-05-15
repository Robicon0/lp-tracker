"use client";

import { useState, type ReactNode } from "react";

const FONT = "'JetBrains Mono','Courier New',monospace";

interface Props {
  /** Tooltip body — string or JSX. Renders inside the floating panel. */
  text: ReactNode;
  /** Tooltip max-width in px. Default 280. Text wraps inside this box. */
  maxWidth?: number;
}

/**
 * Small ⓘ icon that opens a styled tooltip on hover / focus / tap.
 *
 * Triggers: hover (mouse), focus (keyboard), click (touch).
 * Accessibility: button has aria-label, the panel uses role="tooltip".
 *
 * Visual contract (locked — see CLAUDE.md):
 *   - Panel anchors ABOVE the icon (`bottom: calc(100% + 10px)`) so it never
 *     overlaps the data row below the label.
 *   - Solid dark background (#0a0a0a) — opaque, no bleed-through.
 *   - 0.5px faint emerald border (#00ff8844), 4px radius.
 *   - 12px 14px padding, max-width 280px, JetBrains Mono 11px / 1.6 line-height.
 *   - z-index 9999 sits above every dashboard surface (TerminalNavbar is 10000
 *     but the tooltip never renders that high in the DOM).
 *   - Downward-pointing CSS-triangle arrow at the bottom-left of the panel
 *     points at the ⓘ icon below.
 *   - `pointer-events: none` so a stray cursor over the tooltip area doesn't
 *     trigger the icon's onMouseLeave; the tooltip disappears when the mouse
 *     leaves the icon itself.
 */
export default function InfoTooltip({ text, maxWidth = 280 }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <span
      style={{
        position: "relative",
        display: "inline-flex",
        marginLeft: 6,
        verticalAlign: "middle",
      }}
    >
      <button
        type="button"
        aria-label="More info"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 14,
          height: 14,
          borderRadius: "50%",
          border: "1px solid rgba(0,255,65,0.35)",
          background: "rgba(0,255,65,0.06)",
          color: "#00ff41",
          fontSize: 9,
          fontWeight: 700,
          fontFamily: FONT,
          cursor: "help",
          padding: 0,
          lineHeight: 1,
        }}
      >
        i
      </button>
      {open && (
        <span
          role="tooltip"
          style={{
            position: "absolute",
            bottom: "calc(100% + 10px)",
            left: 0,
            zIndex: 9999,
            maxWidth,
            // Force a sensible minimum width so very short text still reads
            // as a tooltip rather than a tiny chip.
            minWidth: 200,
            // Opaque solid background — no transparency. Content behind the
            // tooltip must never bleed through (the previous semi-transparent
            // #0a1f17 read as foggy when the tooltip overlapped data rows).
            background: "#0a0a0a",
            border: "0.5px solid #00ff8844",
            borderRadius: 4,
            padding: "12px 14px",
            color: "#aaaaaa",
            fontSize: 11,
            fontFamily: FONT,
            lineHeight: 1.6,
            letterSpacing: "0.02em",
            whiteSpace: "normal",
            wordBreak: "normal",
            overflowWrap: "break-word",
            textTransform: "none",
            textAlign: "left",
            fontWeight: 400,
            boxShadow: "0 4px 24px rgba(0,0,0,0.6)",
            pointerEvents: "none",
          }}
        >
          {text}
          {/* Downward-pointing CSS triangle anchored at the bottom-left,
              centered under the ⓘ icon (icon is 14px wide starting at left=0
              of the parent span; triangle center at ~7px). */}
          <span
            aria-hidden
            style={{
              position: "absolute",
              bottom: -6,
              left: 4,
              width: 0,
              height: 0,
              borderLeft: "6px solid transparent",
              borderRight: "6px solid transparent",
              borderTop: "6px solid #00ff8844",
            }}
          />
        </span>
      )}
    </span>
  );
}
