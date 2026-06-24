"use client";

import { useState, type FormEvent } from "react";

// Sprint EMAIL — homepage ship-notification email capture. POSTs to
// /api/subscribe, which persists to Neon Postgres. No accounts, no login, no
// wallet coupling. Aesthetic mirrors the hero "// or paste any address" SCAN
// input (HeroWalletConnect.tsx): >_ prefix span + bordered container, #00ff41
// green (the established brand token), JetBrains Mono.

// Same shape check the server uses — pre-validate to skip a pointless round
// trip; the server is authoritative.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Status = "idle" | "submitting" | "success" | "error";

// min-height shared by the input row and the success message so swapping one
// for the other doesn't shift the page.
const SWAP_MIN_HEIGHT = 46;

export default function ShipNotifications() {
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

  return (
    <section className="grid grid-cols-1 lg:grid-cols-2 px-4 sm:px-12 border-b border-[#1f1f1f]">
      {/* LEFT */}
      <div className="lg:border-r border-[#1f1f1f] lg:pr-16 py-12 flex flex-col justify-center min-w-0">
        <div className="text-[12px] text-[#888] uppercase tracking-[0.2em] mb-6 flex items-center gap-3">
          <span className="text-[#00ff41]">//</span>
          <span>SHIP_NOTIFICATIONS</span>
        </div>
        <h2
          className="text-[#e8e8e8] mb-4"
          style={{ fontSize: 26, fontWeight: 500, lineHeight: 1.3, letterSpacing: "-0.01em" }}
        >
          Get notified when your chain ships.
        </h2>
        <p className="text-[#c8c8c8] max-w-[460px]" style={{ fontSize: 15, lineHeight: 1.6 }}>
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
              className="flex items-center border border-[#00ff41]/60 bg-[rgba(0,255,65,0.06)] px-3.5 text-[#00ff41]"
              style={{ minHeight: SWAP_MIN_HEIGHT, fontSize: 15, letterSpacing: "0.02em" }}
            >
              ✓ You&apos;re in. We&apos;ll email you when something ships.
            </div>
          ) : (
            <form
              onSubmit={handleSubmit}
              className="flex border border-[#2e2e2e] focus-within:border-[#00ff41]/60 transition-colors"
              style={{ minHeight: SWAP_MIN_HEIGHT }}
            >
              <span
                className="bg-[#111] text-[#00ff41] px-3.5 py-2.5 text-[15px] border-r border-[#2e2e2e] select-none flex-shrink-0 flex items-center"
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
                className="flex-1 bg-[#0a0a0a] text-[#e8e8e8] px-3.5 py-2.5 text-[15px] outline-none placeholder:text-[#888] min-w-0"
                style={{ fontFamily: "var(--font-jetbrains-mono)", letterSpacing: "0.04em" }}
              />
              <button
                type="submit"
                disabled={status === "submitting"}
                className="bg-[#00ff41] hover:bg-[#00cc33] text-black font-bold tracking-[0.1em] uppercase border-l border-[#2e2e2e] px-5 text-[14px] transition-colors whitespace-nowrap inline-flex items-center justify-center disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {status === "submitting" ? "..." : "SUBSCRIBE"}
              </button>
            </form>
          )}

          {/* Status line — fixed height so the helper/error swap doesn't shift layout. */}
          <div style={{ minHeight: 20, marginTop: 8 }}>
            {status === "error" && errorMsg ? (
              <span role="alert" style={{ fontSize: 12, color: "#ff3355", letterSpacing: "0.04em" }}>
                {errorMsg}
              </span>
            ) : status === "success" ? null : (
              <span style={{ fontSize: 12, color: "#888", letterSpacing: "0.04em" }}>
                No login. No password. Unsubscribe anytime.
              </span>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
