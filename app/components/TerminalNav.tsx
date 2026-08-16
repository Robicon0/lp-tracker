"use client";

import Link from "next/link";
import { Fragment } from "react";
import CalculatorMenu from "./CalculatorMenu";
import MobileNavMenu from "./MobileNavMenu";

const TABS: { label: string; href: string; key: "home" | "dashboard" | "analytics" | "about" }[] = [
  { label: "Home", href: "/", key: "home" },
  { label: "Dashboard", href: "/dashboard", key: "dashboard" },
  { label: "Analytics", href: "/analytics", key: "analytics" },
  { label: "About", href: "/about", key: "about" },
];

export default function TerminalNav({
  active,
}: {
  active?: "home" | "dashboard" | "analytics" | "about";
}) {
  return (
    <nav
      className="sticky top-0 z-[300] h-[52px] flex items-stretch border-b border-[var(--line)] backdrop-blur-[12px]"
      // --nav-surface, not --overlay — same reason as TerminalNavbar: an
      // overlay scrim's alpha is tuned for letting the page show through,
      // which behind a pinned nav means content reads straight through it.
      style={{ background: "var(--nav-surface)", fontFamily: "var(--font-jetbrains-mono)" }}
    >
      <Link
        href="/"
        className="px-7 flex items-center border-r border-[var(--line)] no-underline"
        style={{ fontSize: 20, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase" }}
      >
        <span className="text-[var(--accent)] font-extrabold">DEFI</span>
        <span className="text-[var(--line-strong)] font-light mx-[2px]">/</span>
        <span className="text-[var(--fg)] font-extrabold">DESH</span>
      </Link>
      <div className="term-nav-tabs flex">
        {TABS.map((t) => {
          const isActive = active === t.key;
          return (
            <Fragment key={t.key}>
            <Link
              href={t.href}
              className={`relative flex items-center px-[22px] border-r border-[var(--line)] no-underline transition-colors hover:bg-[var(--surface)] hover:text-[var(--fg-muted)] ${isActive ? "text-[var(--fg)]" : "text-[var(--fg-muted)]"}`}
              style={{
                fontSize: 15,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
              }}
            >
              {t.label}
              {isActive && (
                <span
                  className="absolute left-0 right-0 h-px bg-[var(--accent)]"
                  style={{ bottom: -1, boxShadow: "0 0 8px color-mix(in srgb, var(--accent) 18%, transparent)" }}
                />
              )}
            </Link>
            {/* Calculator sits immediately after Analytics rather than after
                the whole list, which is why this renders inside the map. */}
            {t.key === "analytics" && <CalculatorMenu variant="tab" />}
            </Fragment>
          );
        })}
      </div>
      <div className="flex-1" />
      {/* Matched pair: READ-ONLY badge and LIVE pill share identical
          container styling. Only difference is text + the pulsing dot on
          ALL SYSTEMS NOMINAL. */}
      <div
        className="term-nav-ro-badge flex items-center my-[10px] mr-2"
        style={{
          padding: "5px 12px",
          border: "0.5px solid var(--accent)",
          background: "var(--accent-surface)",
          borderRadius: 3,
          fontSize: 13,
          color: "var(--accent)",
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          whiteSpace: "nowrap",
        }}
      >
        ■ READ-ONLY · NON-CUSTODIAL
      </div>
      <div
        className="flex items-center gap-2 my-[10px] mr-4"
        style={{
          padding: "5px 12px",
          border: "0.5px solid var(--accent)",
          background: "var(--accent-surface)",
          borderRadius: 3,
          fontSize: 13,
          color: "var(--accent)",
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          whiteSpace: "nowrap",
        }}
      >
        <span
          className="inline-block w-1.5 h-1.5 bg-[var(--accent)]"
          style={{ animation: "tn-pulse 2s infinite" }}
        />
        <span>All systems nominal</span>
      </div>
      <MobileNavMenu />
      <style
        dangerouslySetInnerHTML={{
          __html: "@keyframes tn-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.25 } }",
        }}
      />
    </nav>
  );
}
