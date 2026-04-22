"use client";

import { useEffect, useState } from "react";

const CATEGORIES = [
  "LP Positions",
  "Analytics",
  "P&L/IL",
  "Loading speed",
  "Wrong numbers",
  "Feature request",
];

const FORMSPREE_URL = "https://formspree.io/f/mzdyjybw";

export default function FloatingFeedback() {
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(0);
  const [hoverRating, setHoverRating] = useState(0);
  const [categories, setCategories] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [thanks, setThanks] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  function toggleCategory(c: string) {
    setCategories((curr) =>
      curr.includes(c) ? curr.filter((x) => x !== c) : [...curr, c],
    );
  }

  function reset() {
    setRating(0);
    setHoverRating(0);
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

  return (
    <>
      {/* Floating launcher */}
      <button
        type="button"
        aria-label="Share feedback"
        onClick={() => setOpen(true)}
        style={{
          position: "fixed",
          right: 20,
          bottom: 20,
          width: 52,
          height: 52,
          borderRadius: "50%",
          background: "linear-gradient(135deg, #10b981 0%, #059669 100%)",
          color: "white",
          border: "1px solid rgba(110, 231, 183, 0.4)",
          boxShadow:
            "0 10px 25px rgba(0,0,0,0.35), 0 0 0 1px rgba(16,185,129,0.25), 0 0 20px rgba(16,185,129,0.35)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 99998,
        }}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </button>

      {open && (
        <div
          onClick={() => !submitting && setOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.7)",
            backdropFilter: "blur(4px)",
            WebkitBackdropFilter: "blur(4px)",
            zIndex: 99999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: "relative",
              width: "100%",
              maxWidth: 460,
              maxHeight: "calc(100vh - 32px)",
              background: "linear-gradient(180deg, #061810 0%, #020806 100%)",
              border: "1px solid rgba(16,185,129,0.25)",
              borderRadius: 16,
              boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
              color: "white",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            {/* Close */}
            <button
              type="button"
              aria-label="Close feedback"
              onClick={() => !submitting && setOpen(false)}
              style={{
                position: "absolute",
                top: 12,
                right: 12,
                width: 28,
                height: 28,
                borderRadius: 6,
                background: "transparent",
                border: "none",
                color: "rgba(255,255,255,0.6)",
                cursor: "pointer",
                fontSize: 18,
                lineHeight: 1,
              }}
            >
              ✕
            </button>

            <div style={{ overflowY: "auto", padding: 24 }}>
              {thanks ? (
                <div style={{ textAlign: "center", padding: "32px 0 20px" }}>
                  <div
                    style={{
                      width: 56,
                      height: 56,
                      borderRadius: "50%",
                      background: "rgba(16,185,129,0.15)",
                      border: "1px solid rgba(16,185,129,0.4)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      margin: "0 auto 16px",
                      color: "#34d399",
                      fontSize: 28,
                    }}
                  >
                    ✓
                  </div>
                  <h3 style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 600 }}>
                    Thank you!
                  </h3>
                  <p style={{ margin: 0, fontSize: 14, color: "rgba(255,255,255,0.6)" }}>
                    Your feedback helps us improve DefiDesh
                  </p>
                </div>
              ) : (
                <form onSubmit={handleSubmit}>
                  <h2 style={{ margin: "0 0 4px", fontSize: 22, fontWeight: 600, color: "white" }}>
                    Share your feedback
                  </h2>
                  <p style={{ margin: "0 0 20px", fontSize: 13, color: "rgba(255,255,255,0.55)" }}>
                    Help us improve DefiDesh
                  </p>

                  {/* Rating */}
                  <div style={{ marginBottom: 20 }}>
                    <p
                      style={{
                        margin: "0 0 8px",
                        fontSize: 11,
                        letterSpacing: 1,
                        textTransform: "uppercase",
                        color: "rgba(255,255,255,0.5)",
                      }}
                    >
                      Rating
                    </p>
                    <div style={{ display: "flex", gap: 6 }}>
                      {[1, 2, 3, 4, 5].map((n) => {
                        const active = n <= (hoverRating || rating);
                        return (
                          <button
                            key={n}
                            type="button"
                            onClick={() => setRating(n)}
                            onMouseEnter={() => setHoverRating(n)}
                            onMouseLeave={() => setHoverRating(0)}
                            aria-label={`${n} star${n > 1 ? "s" : ""}`}
                            style={{
                              background: "transparent",
                              border: "none",
                              cursor: "pointer",
                              padding: 2,
                              color: active ? "#fbbf24" : "rgba(255,255,255,0.2)",
                              fontSize: 28,
                              lineHeight: 1,
                              transition: "color 0.15s",
                            }}
                          >
                            ★
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Categories */}
                  <div style={{ marginBottom: 20 }}>
                    <p
                      style={{
                        margin: "0 0 8px",
                        fontSize: 11,
                        letterSpacing: 1,
                        textTransform: "uppercase",
                        color: "rgba(255,255,255,0.5)",
                      }}
                    >
                      Category
                    </p>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {CATEGORIES.map((c) => {
                        const active = categories.includes(c);
                        return (
                          <button
                            key={c}
                            type="button"
                            onClick={() => toggleCategory(c)}
                            style={{
                              padding: "6px 12px",
                              borderRadius: 999,
                              fontSize: 12,
                              fontWeight: 500,
                              cursor: "pointer",
                              background: active
                                ? "rgba(16,185,129,0.2)"
                                : "rgba(255,255,255,0.04)",
                              color: active ? "#6ee7b7" : "rgba(255,255,255,0.6)",
                              border: active
                                ? "1px solid rgba(16,185,129,0.5)"
                                : "1px solid rgba(255,255,255,0.08)",
                              transition: "all 0.15s",
                            }}
                          >
                            {c}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Message */}
                  <div style={{ marginBottom: 20 }}>
                    <p
                      style={{
                        margin: "0 0 8px",
                        fontSize: 11,
                        letterSpacing: 1,
                        textTransform: "uppercase",
                        color: "rgba(255,255,255,0.5)",
                      }}
                    >
                      Tell us more
                    </p>
                    <textarea
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      rows={4}
                      placeholder="What's on your mind?"
                      style={{
                        width: "100%",
                        padding: 12,
                        borderRadius: 8,
                        background: "rgba(255,255,255,0.04)",
                        border: "1px solid rgba(255,255,255,0.1)",
                        color: "white",
                        fontSize: 13,
                        fontFamily: "inherit",
                        resize: "vertical",
                        outline: "none",
                        boxSizing: "border-box",
                      }}
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={submitting}
                    style={{
                      width: "100%",
                      padding: "11px 18px",
                      borderRadius: 8,
                      background: submitting
                        ? "rgba(16,185,129,0.4)"
                        : "linear-gradient(135deg, #10b981 0%, #059669 100%)",
                      color: "white",
                      fontSize: 14,
                      fontWeight: 600,
                      border: "1px solid rgba(110,231,183,0.3)",
                      cursor: submitting ? "not-allowed" : "pointer",
                    }}
                  >
                    {submitting ? "Sending…" : "Submit feedback"}
                  </button>
                </form>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
