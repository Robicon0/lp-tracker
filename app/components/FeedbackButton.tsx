"use client";

import { useState, useCallback, type CSSProperties } from "react";

// Feedback button + modal wired to Formspree.
//
// To receive feedback emails, the owner must:
//   1. Sign up at https://formspree.io (free tier)
//   2. Create a new form
//   3. Copy the form ID (last segment of the endpoint URL)
//   4. Set NEXT_PUBLIC_FORMSPREE_ID in .env.local (local) and on Vercel
//      (Project Settings → Environment Variables → both Preview + Production)
//   5. Redeploy — feedback will land in the configured Formspree inbox.
//
// Until NEXT_PUBLIC_FORMSPREE_ID is set, the button still works but the
// submit falls through to the placeholder endpoint /f/YOUR_FORM_ID which
// returns a friendly error message.

const FORMSPREE_ID = process.env.NEXT_PUBLIC_FORMSPREE_ID || "YOUR_FORM_ID";

const CATEGORIES = [
  "LP Positions",
  "Analytics",
  "P&L / IL",
  "Loading speed",
  "Wrong numbers",
  "Feature request",
];

// DefiDesh dark-green theme constants
const BG_DEEP    = "#060d08";
const CARD_BG    = "rgba(10,31,23,0.96)";
const BORDER     = "rgba(16,185,129,0.18)";
const TEXT       = "#ecfdf5";
const MUTED      = "rgba(236,253,245,0.55)";
const ACCENT     = "#10b981";
const ACCENT_BG  = "rgba(16,185,129,0.18)";
const ACCENT_SEL = "rgba(16,185,129,0.28)";

export default function FeedbackButton() {
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [categories, setCategories] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setRating(0); setHover(0); setCategories([]); setMessage("");
    setSubmitting(false); setSent(false); setError(null);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    // wait a beat so the close animation can play before clearing fields
    setTimeout(reset, 300);
  }, [reset]);

  const toggleCategory = (c: string) => {
    setCategories((prev) =>
      prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c],
    );
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`https://formspree.io/f/${FORMSPREE_ID}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          rating,
          categories: categories.join(", "),
          message,
          // Human-friendly subject so the inbox is easy to scan
          _subject: `DefiDesh feedback — ${rating || "?"}★`,
          page: typeof window !== "undefined" ? window.location.pathname : "",
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `Formspree returned ${res.status}`);
      }
      setSent(true);
      // Auto-close after 3s so the user doesn't have to hunt for a button
      setTimeout(() => { close(); }, 3000);
    } catch (err) {
      console.error("[FeedbackButton] submit failed:", err);
      setError(err instanceof Error ? err.message : "Failed to send feedback");
    } finally {
      setSubmitting(false);
    }
  };

  const buttonStyle: CSSProperties = {
    background: ACCENT_BG,
    color: "#6ee7b7",
    border: `1px solid ${BORDER}`,
    borderRadius: 8,
    padding: "6px 12px",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    transition: "background 0.15s",
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={buttonStyle}
        onMouseEnter={(e) => (e.currentTarget.style.background = ACCENT_SEL)}
        onMouseLeave={(e) => (e.currentTarget.style.background = ACCENT_BG)}
      >
        Feedback
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Feedback"
          onClick={close}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.72)",
            backdropFilter: "blur(6px)",
            WebkitBackdropFilter: "blur(6px)",
            zIndex: 100,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            overflowY: "auto",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 460,
              maxHeight: "calc(100dvh - 32px)",
              overflowY: "auto",
              WebkitOverflowScrolling: "touch",
              background: CARD_BG,
              backgroundImage: `linear-gradient(135deg, ${BG_DEEP} 0%, #0a1f17 100%)`,
              border: `1px solid ${BORDER}`,
              borderRadius: 16,
              padding: 24,
              color: TEXT,
              boxShadow: "0 20px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(16,185,129,0.06)",
              position: "relative",
            }}
          >
            {!sent && (
              <button
                type="button"
                onClick={close}
                aria-label="Close feedback"
                style={{
                  position: "sticky",
                  top: 0,
                  marginLeft: "auto",
                  marginBottom: -24,
                  marginRight: -8,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 32,
                  height: 32,
                  background: "rgba(16,185,129,0.12)",
                  color: "#6ee7b7",
                  border: `1px solid ${BORDER}`,
                  borderRadius: 999,
                  fontSize: 18,
                  lineHeight: 1,
                  cursor: "pointer",
                  zIndex: 2,
                }}
              >
                ×
              </button>
            )}
            {sent ? (
              <div style={{ textAlign: "center", padding: "24px 0" }}>
                <div style={{
                  width: 56, height: 56, margin: "0 auto 16px",
                  borderRadius: "50%", background: ACCENT_BG,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 28, color: ACCENT,
                }}>✓</div>
                <h3 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 8px", color: TEXT }}>
                  Thank you!
                </h3>
                <p style={{ fontSize: 14, color: MUTED, margin: "0 0 20px", lineHeight: 1.5 }}>
                  Your feedback helps us improve DefiDesh
                </p>
                <button
                  type="button"
                  onClick={close}
                  style={{
                    background: ACCENT_BG,
                    color: "#6ee7b7",
                    border: `1px solid ${BORDER}`,
                    borderRadius: 8,
                    padding: "8px 20px",
                    fontSize: 14,
                    fontWeight: 500,
                    cursor: "pointer",
                  }}
                >
                  Close
                </button>
              </div>
            ) : (
              <>
                <div style={{ marginBottom: 16, paddingRight: 40 }}>
                  <h3 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: TEXT }}>
                    Send feedback
                  </h3>
                </div>

                {/* Star rating */}
                <div style={{ marginBottom: 18 }}>
                  <p style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 1,
                    color: MUTED, margin: "0 0 8px" }}>
                    How would you rate DefiDesh?
                  </p>
                  <div style={{ display: "flex", gap: 6 }}>
                    {[1, 2, 3, 4, 5].map((i) => (
                      <button
                        key={i}
                        type="button"
                        aria-label={`${i} star${i === 1 ? "" : "s"}`}
                        onMouseEnter={() => setHover(i)}
                        onMouseLeave={() => setHover(0)}
                        onClick={() => setRating(i)}
                        style={{
                          background: "transparent",
                          border: "none",
                          cursor: "pointer",
                          fontSize: 28,
                          padding: "2px 4px",
                          color: (hover || rating) >= i ? "#fbbf24" : "rgba(236,253,245,0.25)",
                          transition: "color 0.1s",
                        }}
                      >
                        ★
                      </button>
                    ))}
                  </div>
                </div>

                {/* Category pills */}
                <div style={{ marginBottom: 18 }}>
                  <p style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 1,
                    color: MUTED, margin: "0 0 8px" }}>
                    What&apos;s this about? (pick any)
                  </p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {CATEGORIES.map((c) => {
                      const selected = categories.includes(c);
                      return (
                        <button
                          key={c}
                          type="button"
                          onClick={() => toggleCategory(c)}
                          style={{
                            background: selected ? ACCENT_SEL : "rgba(255,255,255,0.04)",
                            color: selected ? "#6ee7b7" : "rgba(236,253,245,0.7)",
                            border: `1px solid ${selected ? BORDER : "rgba(255,255,255,0.08)"}`,
                            borderRadius: 999,
                            padding: "5px 12px",
                            fontSize: 12,
                            fontWeight: 500,
                            cursor: "pointer",
                            transition: "all 0.12s",
                          }}
                        >
                          {c}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Message */}
                <div style={{ marginBottom: 18 }}>
                  <p style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 1,
                    color: MUTED, margin: "0 0 8px" }}>
                    Tell us more
                  </p>
                  <textarea
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    rows={4}
                    placeholder="What's working? What's broken? What would you love to see?"
                    style={{
                      width: "100%",
                      background: "rgba(255,255,255,0.04)",
                      color: TEXT,
                      border: "1px solid rgba(255,255,255,0.08)",
                      borderRadius: 10,
                      padding: "10px 12px",
                      fontSize: 14,
                      fontFamily: "inherit",
                      resize: "vertical",
                      outline: "none",
                      boxSizing: "border-box",
                    }}
                    onFocus={(e) => (e.currentTarget.style.borderColor = BORDER)}
                    onBlur={(e) => (e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)")}
                  />
                </div>

                {error && (
                  <p style={{ fontSize: 12, color: "#fca5a5", marginBottom: 10 }}>
                    {error}
                  </p>
                )}

                <button
                  type="button"
                  onClick={submit}
                  disabled={submitting || (!message && rating === 0 && categories.length === 0)}
                  style={{
                    width: "100%",
                    background: submitting ? "rgba(16,185,129,0.3)" : ACCENT,
                    color: "white",
                    border: "none",
                    borderRadius: 10,
                    padding: "10px 16px",
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: submitting ? "wait" : "pointer",
                    opacity: (!message && rating === 0 && categories.length === 0) ? 0.5 : 1,
                  }}
                >
                  {submitting ? "Sending…" : "Submit feedback"}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
