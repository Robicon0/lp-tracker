"use client";

import { useEffect, useState, type CSSProperties } from "react";

const CATEGORIES = [
  "LP Positions",
  "Analytics",
  "P&L/IL",
  "Loading speed",
  "Wrong numbers",
  "Feature request",
];

const RATE_LABELS = ["poor", "low", "okay", "good", "great"];

const FORMSPREE_URL = "https://formspree.io/f/mzdyjybw";

// Terminal palette (matches dashboard.html exactly)
const C = {
  bg:        "#050505",
  bg1:       "#090909",
  bg2:       "#0d0d0d",
  bg3:       "#121212",
  bg4:       "#171717",
  border:    "#1c1c1c",
  borderHi:  "#262626",
  borderGlow:"#2e2e2e",
  text:      "#a8a8a8",
  textMid:   "#b4b4b4",
  textBright:"#e8e8e8",
  textWhite: "#f5f5f5",
  green:     "#00ff41",
  green2:    "#00e535",
  greenDim:  "#00b82a",
  greenFaint:"rgba(0,255,65,0.06)",
  greenGlow: "rgba(0,255,65,0.18)",
  red:       "#ff3355",
  amber:     "#ffaa00",
} as const;

const FONT = "'JetBrains Mono','Courier New',monospace";

export default function FloatingFeedback() {
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(0);
  const [categories, setCategories] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [thanks, setThanks] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, submitting]);

  function toggleCategory(c: string) {
    setCategories((curr) =>
      curr.includes(c) ? curr.filter((x) => x !== c) : [...curr, c],
    );
  }

  function reset() {
    setRating(0);
    setCategories([]);
    setMessage("");
    setThanks(false);
    setSubmitting(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      await fetch(FORMSPREE_URL, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          rating,
          categories: categories.join(", "),
          message,
        }),
      });
    } catch {
      // swallow — still show thanks per spec
    }
    setThanks(true);
    setTimeout(() => {
      setOpen(false);
      reset();
    }, 3000);
  }

  const canSubmit = !submitting && (rating > 0 || categories.length > 0 || message.trim().length > 0);

  // ── Styles ────────────────────────────────────────────────────────────
  const overlayStyle: CSSProperties = {
    position: "fixed", inset: 0, zIndex: 99999,
    background: "rgba(0,0,0,0.78)",
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
    display: "flex", alignItems: "center", justifyContent: "center",
    padding: 16,
    fontFamily: FONT,
    animation: "_fbFade 0.18s ease",
  };
  const modalStyle: CSSProperties = {
    width: "94%", maxWidth: 520,
    maxHeight: "calc(100vh - 32px)",
    background: C.bg,
    border: `1px solid ${C.greenDim}`,
    boxShadow: `0 0 0 1px rgba(0,255,65,0.08), 0 0 64px rgba(0,255,65,0.18), 0 24px 80px rgba(0,0,0,0.7)`,
    position: "relative",
    color: C.text,
    fontFamily: FONT,
    display: "flex", flexDirection: "column",
    animation: "_fbUp 0.22s ease",
  };
  const labelRowStyle: CSSProperties = {
    display: "flex", alignItems: "baseline", gap: 10,
    fontSize: 11, color: C.text, letterSpacing: "0.22em",
    textTransform: "uppercase", marginBottom: 10, opacity: 0.7,
  };
  const labelHintStyle: CSSProperties = {
    marginLeft: "auto", opacity: 0.55, fontSize: 10, letterSpacing: "0.16em",
  };

  return (
    <>
      <style>{`
        @keyframes _fbFade { from{opacity:0} to{opacity:1} }
        @keyframes _fbUp   { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
        @keyframes _fbPulse{ 0%,100%{opacity:1} 50%{opacity:0.25} }
        .fb-fab-hover:hover { background: rgba(0,255,65,0.12) !important; box-shadow: 0 0 26px rgba(0,255,65,0.32) !important; transform: translateY(-2px); }
        .fb-rate-hover:hover { color: ${C.textBright} !important; border-color: ${C.borderGlow} !important; background: ${C.bg3} !important; }
        .fb-cat-hover:hover { color: ${C.textBright} !important; border-color: ${C.borderGlow} !important; }
        .fb-submit-hover:hover:not(:disabled) { background: ${C.green2} !important; box-shadow: 0 0 28px rgba(0,255,65,0.35); letter-spacing: 0.2em; }
        .fb-cancel-hover:hover { color: ${C.textBright} !important; border-color: ${C.borderGlow} !important; }
        .fb-close-hover:hover { color: ${C.red} !important; border-color: rgba(255,51,85,0.4) !important; background: rgba(255,51,85,0.06) !important; }
        .fb-textarea-wrap:focus-within { border-color: ${C.greenDim} !important; box-shadow: 0 0 0 1px rgba(0,255,65,0.12); }
      `}</style>

      {/* ── Floating launcher (terminal fab) ───────────────────────────── */}
      <button
        type="button"
        aria-label="Share feedback"
        title="Share feedback"
        onClick={() => setOpen(true)}
        className="fb-fab-hover"
        style={{
          position: "fixed",
          right: 22,
          bottom: 22,
          zIndex: 99998,
          width: 46,
          height: 46,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: `1px solid ${C.greenDim}`,
          background: C.greenFaint,
          color: C.green,
          cursor: "pointer",
          transition: "all 0.2s",
          boxShadow: "0 0 18px rgba(0,255,65,0.16)",
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
        </svg>
      </button>

      {open && (
        <div
          onClick={(e) => {
            if (e.target === e.currentTarget && !submitting) setOpen(false);
          }}
          style={overlayStyle}
        >
          <div onClick={(e) => e.stopPropagation()} style={modalStyle} role="dialog" aria-label="Share your feedback">
            {/* Terminal title bar */}
            <div style={{
              display: "flex", alignItems: "center", gap: 10,
              height: 32, padding: "0 14px",
              borderBottom: `1px solid ${C.border}`,
              background: "linear-gradient(180deg, #0a120a, #050805)",
              position: "relative",
              flexShrink: 0,
            }}>
              {/* 3 colored dots */}
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ width: 8, height: 8, background: "rgba(255,51,85,0.5)", border: "1px solid rgba(255,51,85,0.5)" }} />
                <span style={{ width: 8, height: 8, background: "rgba(255,170,0,0.5)", border: "1px solid rgba(255,170,0,0.5)" }} />
                <span style={{ width: 8, height: 8, background: C.green, border: `1px solid ${C.green}`, boxShadow: `0 0 6px ${C.greenGlow}` }} />
              </div>
              <div style={{ fontSize: 12, color: C.text, letterSpacing: "0.1em", flex: 1, textAlign: "center" }}>
                ~/defidesh/feedback.tx
                <span style={{ color: C.green, animation: "_fbPulse 1.2s infinite", marginLeft: 4 }}>▋</span>
              </div>
              <button
                type="button"
                onClick={() => !submitting && setOpen(false)}
                aria-label="Close"
                className="fb-close-hover"
                style={{
                  width: 22, height: 22,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: "transparent",
                  border: "1px solid transparent",
                  color: C.text,
                  cursor: "pointer",
                  fontSize: 15,
                  padding: 0,
                  fontFamily: FONT,
                  transition: "all 0.15s",
                }}
              >
                ✕
              </button>
            </div>

            {/* Body */}
            <div style={{ padding: "24px 24px 22px", overflowY: "auto", flex: 1 }}>
              {thanks ? (
                <div style={{ textAlign: "center", padding: "20px 10px 8px", animation: "_fbUp 0.3s ease" }}>
                  <div style={{
                    width: 56, height: 56, margin: "0 auto 16px",
                    border: `1px solid ${C.green}`, background: C.greenFaint,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    color: C.green, fontSize: 28, fontWeight: 700,
                    boxShadow: "0 0 26px rgba(0,255,65,0.28)",
                  }}>
                    ✓
                  </div>
                  <h3 style={{ fontSize: 20, color: C.textWhite, fontWeight: 700, marginBottom: 6, letterSpacing: "-0.01em" }}>
                    Transmission received.
                  </h3>
                  <p style={{ fontSize: 14, color: C.textMid, letterSpacing: "0.04em" }}>
                    Logged — thanks for the signal.
                  </p>
                </div>
              ) : (
                <form onSubmit={handleSubmit}>
                  {/* $ echo > feedback */}
                  <div style={{
                    fontSize: 14, color: C.green,
                    letterSpacing: "0.08em", marginBottom: 4,
                  }}>
                    <span style={{ opacity: 0.7 }}>$ </span>echo &gt; feedback
                  </div>
                  <div style={{
                    fontSize: 28, fontWeight: 700, color: C.textWhite,
                    letterSpacing: "-0.02em", marginBottom: 6, lineHeight: 1.1,
                  }}>
                    Share your feedback
                  </div>
                  <div style={{
                    fontSize: 14, color: C.textMid, opacity: 0.75,
                    letterSpacing: "0.04em", marginBottom: 22,
                  }}>
                    Help us improve DefiDesh
                  </div>

                  {/* ── RATING ─────────────────────────────────────── */}
                  <div style={{ marginBottom: 20 }}>
                    <div style={labelRowStyle}>
                      <span style={{ color: C.green, fontSize: 10, opacity: 0.9 }}>▍</span>
                      <span>Rating</span>
                      <span style={labelHintStyle}>
                        {rating > 0 ? (
                          <>
                            <span style={{ color: C.green, opacity: 0.9 }}>{rating}</span>
                            /5 · {RATE_LABELS[rating - 1]}
                          </>
                        ) : (
                          "tap a number"
                        )}
                      </span>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6 }}>
                      {[1, 2, 3, 4, 5].map((n) => {
                        const active = rating === n;
                        return (
                          <button
                            key={n}
                            type="button"
                            onClick={() => setRating(active ? 0 : n)}
                            aria-label={`Rate ${n} out of 5`}
                            className={active ? "" : "fb-rate-hover"}
                            style={{
                              fontFamily: FONT, fontSize: 17, fontWeight: 700,
                              padding: "14px 0",
                              border: `1px solid ${active ? C.greenDim : C.borderHi}`,
                              background: active ? C.greenFaint : C.bg2,
                              color: active ? C.green : C.textMid,
                              cursor: "pointer",
                              transition: "all 0.12s",
                              display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                              boxShadow: active ? "inset 0 0 12px rgba(0,255,65,0.1), 0 0 12px rgba(0,255,65,0.15)" : "none",
                            }}
                          >
                            <span>{n}</span>
                            <small style={{
                              fontSize: 7, color: active ? C.greenDim : C.text,
                              letterSpacing: "0.18em", textTransform: "uppercase",
                              fontWeight: 500, opacity: active ? 1 : 0.55,
                            }}>
                              {RATE_LABELS[n - 1]}
                            </small>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* ── CATEGORY ───────────────────────────────────── */}
                  <div style={{ marginBottom: 20 }}>
                    <div style={labelRowStyle}>
                      <span style={{ color: C.green, fontSize: 10, opacity: 0.9 }}>▍</span>
                      <span>Category</span>
                      <span style={labelHintStyle}>pick any</span>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                      {CATEGORIES.map((c) => {
                        const active = categories.includes(c);
                        return (
                          <button
                            key={c}
                            type="button"
                            onClick={() => toggleCategory(c)}
                            className={active ? "" : "fb-cat-hover"}
                            style={{
                              fontFamily: FONT, fontSize: 12,
                              letterSpacing: "0.08em",
                              padding: "9px 12px",
                              border: `1px solid ${active ? C.greenDim : C.borderHi}`,
                              background: active ? C.greenFaint : C.bg2,
                              color: active ? C.green : C.textMid,
                              cursor: "pointer",
                              transition: "all 0.15s",
                              textAlign: "left",
                              display: "flex", alignItems: "center", gap: 8,
                              boxShadow: active ? "0 0 10px rgba(0,255,65,0.1)" : "none",
                            }}
                          >
                            <span style={{
                              color: active ? C.green : C.text,
                              opacity: active ? 1 : 0.5,
                              fontSize: 11, letterSpacing: 0,
                            }}>
                              {active ? "[✓]" : "[ ]"}
                            </span>
                            {c}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* ── MESSAGE ────────────────────────────────────── */}
                  <div style={{ marginBottom: 20 }}>
                    <div style={labelRowStyle}>
                      <span style={{ color: C.green, fontSize: 10, opacity: 0.9 }}>▍</span>
                      <span>Tell us more</span>
                      <span style={labelHintStyle}>{message.length}/500</span>
                    </div>
                    <div
                      className="fb-textarea-wrap"
                      style={{
                        position: "relative",
                        border: `1px solid ${C.borderHi}`,
                        background: C.bg,
                        transition: "border-color 0.15s, box-shadow 0.15s",
                      }}
                    >
                      <span aria-hidden style={{
                        position: "absolute", left: 12, top: 12,
                        color: C.green, fontSize: 16, opacity: 0.75,
                        pointerEvents: "none",
                      }}>
                        &gt;
                      </span>
                      <textarea
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        maxLength={500}
                        placeholder="What's on your mind?"
                        style={{
                          width: "100%", minHeight: 88,
                          fontFamily: FONT, fontSize: 15, lineHeight: 1.55,
                          background: "transparent", border: "none",
                          color: C.textBright, padding: "12px 14px 12px 28px",
                          resize: "vertical", outline: "none",
                          boxSizing: "border-box",
                        }}
                      />
                    </div>
                  </div>

                  {/* ── ACTIONS ────────────────────────────────────── */}
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
                    <button
                      type="button"
                      onClick={() => !submitting && setOpen(false)}
                      className="fb-cancel-hover"
                      style={{
                        fontFamily: FONT, fontSize: 12, fontWeight: 600,
                        letterSpacing: "0.14em", textTransform: "uppercase",
                        padding: "13px 16px", cursor: "pointer",
                        transition: "all 0.15s",
                        background: "transparent", color: C.text,
                        border: `1px solid ${C.borderHi}`,
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={!canSubmit}
                      className="fb-submit-hover"
                      style={{
                        flex: 1,
                        fontFamily: FONT, fontSize: 14, fontWeight: 700,
                        letterSpacing: "0.16em", textTransform: "uppercase",
                        padding: "13px 18px",
                        cursor: canSubmit ? "pointer" : "not-allowed",
                        transition: "all 0.15s",
                        background: canSubmit ? C.green : C.bg3,
                        color: canSubmit ? "#000" : C.text,
                        border: "none",
                        opacity: canSubmit ? 1 : 0.4,
                        display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
                      }}
                    >
                      {submitting ? "Transmitting…" : "Submit feedback"}
                      {!submitting && <span style={{ opacity: 0.6 }}>{"›››"}</span>}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
