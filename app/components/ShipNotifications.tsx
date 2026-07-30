"use client";

import { useState, type FormEvent } from "react";
import { Shell } from "./home/Shell";

// Sprint EMAIL — homepage ship-notification email capture. POSTs to
// /api/subscribe, which persists to Neon Postgres. No accounts, no login, no
// wallet coupling. Aesthetic mirrors the hero "// or paste any address" SCAN
// input (HeroWalletConnect.tsx): >_ prefix span + bordered container, var(--accent)
// green (the established brand token), JetBrains Mono.

// Same shape check the server uses — pre-validate to skip a pointless round
// trip; the server is authoritative.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Status = "idle" | "submitting" | "success" | "error";

// min-height shared by the input row and the success message so swapping one
// for the other doesn't shift the page.
const SWAP_MIN_HEIGHT = 46;

/**
 * `railed` (Home v2) puts the two columns AND the section's bottom rule on the
 * page rail (`--maxw` / `--gutter` via <Shell>). Without it the section used its
 * own `px-4 sm:px-12` with no max-width, so on a wide monitor the email form
 * drifted far right of the column every other section's right-hand content sits
 * in, and the bottom rule overshot the content column by hundreds of px.
 * Legacy home (`railed` omitted) keeps the original edge-to-edge treatment,
 * which is what its own un-railed sections align to.
 */
export default function ShipNotifications({ railed = false }: { railed?: boolean } = {}) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (status === "submitting") return;

    const value = email.trim();
    if (!EMAIL_RE.test(value)) {
      setStatus("error");
      setErrorMsg("Please enter a valid email.");
      return;
    }

    setStatus("submitting");
    setErrorMsg(null);
    try {
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: value }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };

      if (res.ok && data?.ok) {
        setStatus("success");
      } else if (res.status === 400) {
        setStatus("error");
        setErrorMsg("Please enter a valid email.");
      } else {
        setStatus("error");
        setErrorMsg("Something went wrong. Please try again.");
      }
    } catch {
      setStatus("error");
      setErrorMsg("Something went wrong. Please try again.");
    }
  }

  const columns = (
    <>
      {/* LEFT */}
      <div className="lg:border-r border-[var(--line)] lg:pr-16 py-12 flex flex-col justify-center min-w-0">
        <div className="text-[12px] text-[var(--fg-subtle)] uppercase tracking-[0.2em] mb-6 flex items-center gap-3">
          <span className="text-[var(--accent)]">//</span>
          <span>SHIP_NOTIFICATIONS</span>
        </div>
        <h2
          className="text-[var(--fg)] mb-4"
          style={{ fontSize: 26, fontWeight: 500, lineHeight: 1.3, letterSpacing: "-0.01em" }}
        >
          Get notified when your chain ships.
        </h2>
        <p className="text-[var(--fg-muted)] max-w-[460px]" style={{ fontSize: 15, lineHeight: 1.6 }}>
          Solana closed positions. Aptos. Sei. Cross-chain Capital G/L breakdowns. One email when
          each ships. No marketing.
        </p>
      </div>

      {/* RIGHT */}
      <div className="lg:pl-16 py-12 flex flex-col justify-center">
        <div className="w-full max-w-[480px]">
          {status === "success" ? (
            <div
              role="status"
              className="flex items-center border border-[var(--accent)]/60 bg-[color-mix(in srgb, var(--accent) 6%, transparent)] px-3.5 text-[var(--accent)]"
              style={{ minHeight: SWAP_MIN_HEIGHT, fontSize: 15, letterSpacing: "0.02em" }}
            >
              ✓ You&apos;re in. We&apos;ll email you when something ships.
            </div>
          ) : (
            <form
              onSubmit={handleSubmit}
              className="flex border border-[var(--line-strong)] focus-within:border-[var(--accent)]/60 transition-colors"
              style={{ minHeight: SWAP_MIN_HEIGHT }}
            >
              <span
                className="bg-[var(--surface)] text-[var(--accent)] px-3.5 py-2.5 text-[15px] border-r border-[var(--line-strong)] select-none flex-shrink-0 flex items-center"
                style={{ fontFamily: "var(--font-jetbrains-mono)" }}
              >
                {">_"}
              </span>
              <input
                type="email"
                aria-label="Email address"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (status === "error") {
                    setStatus("idle");
                    setErrorMsg(null);
                  }
                }}
                spellCheck={false}
                autoComplete="email"
                placeholder="your@email.com"
                disabled={status === "submitting"}
                className="flex-1 bg-[var(--surface)] text-[var(--fg)] px-3.5 py-2.5 text-[15px] outline-none placeholder:text-[var(--fg-subtle)] min-w-0"
                style={{ fontFamily: "var(--font-jetbrains-mono)", letterSpacing: "0.04em" }}
              />
              <button
                type="submit"
                disabled={status === "submitting"}
                className="bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-fg)] font-bold tracking-[0.1em] uppercase border-l border-[var(--line-strong)] px-5 text-[14px] transition-colors whitespace-nowrap inline-flex items-center justify-center disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {status === "submitting" ? "..." : "SUBSCRIBE"}
              </button>
            </form>
          )}

          {/* Status line — fixed height so the helper/error swap doesn't shift layout. */}
          <div style={{ minHeight: 20, marginTop: 8 }}>
            {status === "error" && errorMsg ? (
              <span role="alert" style={{ fontSize: 12, color: "var(--neg)", letterSpacing: "0.04em" }}>
                {errorMsg}
              </span>
            ) : status === "success" ? null : (
              <span style={{ fontSize: 12, color: "var(--fg-subtle)", letterSpacing: "0.04em" }}>
                No login. No password. Unsubscribe anytime.
              </span>
            )}
          </div>
        </div>
      </div>
    </>
  );

  const GRID = "grid grid-cols-1 lg:grid-cols-2";

  if (railed) {
    // The bottom rule is railed too, NOT full-bleed on the <section>. A
    // full-bleed rule under a railed grid overshoots the content column by
    // hundreds of px on a wide monitor and reads as a line that runs off into
    // nothing — see the note in PriceTickerStrip.
    return (
      <section>
        <Shell innerClassName={`${GRID} border-b border-[var(--line)]`}>{columns}</Shell>
      </section>
    );
  }

  return (
    <section className={`${GRID} px-4 sm:px-12 border-b border-[var(--line)]`}>
      {columns}
    </section>
  );
}
