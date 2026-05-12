"use client";

import { useState } from "react";

export default function FeedbackTab() {
  const [hover, setHover] = useState(false);

  const open = () => {
    // The existing FloatingFeedback (mounted globally in layout.tsx) is
    // visually hidden on this page — fire its click handler programmatically
    // so its modal still opens.
    const btn = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Share feedback"]',
    );
    if (btn) btn.click();
  };

  return (
    <button
      type="button"
      aria-label="Open feedback"
      onClick={open}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "fixed",
        right: hover ? -28 : -36,
        top: "50%",
        zIndex: 1000,
        transform: "translateY(-50%) rotate(90deg)",
        transformOrigin: "center center",
        display: "flex",
        alignItems: "center",
        gap: 7,
        padding: "8px 16px",
        border: `1px solid ${hover ? "#00cc33" : "#262626"}`,
        borderBottom: "none",
        background: hover ? "rgba(0,255,65,0.06)" : "#0a0a0a",
        color: hover ? "#00ff41" : "#888",
        fontFamily: "var(--font-jetbrains-mono)",
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: "0.18em",
        textTransform: "uppercase",
        cursor: "pointer",
        boxShadow: hover ? "0 0 16px rgba(0,255,65,0.1)" : "none",
        transition: "all 0.2s",
      }}
    >
      <span
        style={{
          width: 5,
          height: 5,
          background: "#00ff41",
          flexShrink: 0,
          animation: "pulse 2s infinite",
        }}
      />
      <span>Feedback</span>
    </button>
  );
}
