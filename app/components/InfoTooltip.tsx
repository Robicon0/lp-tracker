"use client";

import { useState, type ReactNode } from "react";

const FONT = "'JetBrains Mono','Courier New',monospace";

interface Props {
  /** Tooltip body — string or JSX. Renders inside the floating panel. */
  text: ReactNode;
  /** Tooltip width in px. Default 280. */
  width?: number;
  /** Where the panel anchors relative to the icon. Default "bottom-left". */
  align?: "bottom-left" | "bottom-right";
}

/**
 * Small ⓘ icon that opens a styled tooltip on hover / focus / tap.
 *
 * Triggers: hover (mouse), focus (keyboard), click (touch).
 * Accessibility: button has aria-label, the panel uses role="tooltip".
 *
 * Visual style follows the site's terminal aesthetic: dark green-tinted
 * background, faint emerald border, JetBrains Mono. Sized to sit inline
 * next to a label without disrupting the line height.
 */
export default function InfoTooltip({ text, width = 280, align = "bottom-left" }: Props) {
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
            top: "calc(100% + 8px)",
            ...(align === "bottom-right" ? { right: 0 } : { left: 0 }),
            zIndex: 40,
            width,
            padding: "10px 12px",
            background: "#0a1f17",
            border: "1px solid rgba(0,255,65,0.3)",
            borderRadius: 4,
            boxShadow: "0 0 24px rgba(0,255,65,0.12)",
            color: "#e0e0e0",
            fontSize: 12,
            fontFamily: FONT,
            lineHeight: 1.55,
            letterSpacing: "0.02em",
            whiteSpace: "normal",
            textTransform: "none",
            pointerEvents: "none",
            textAlign: "left",
          }}
        >
          {text}
        </span>
      )}
    </span>
  );
}
