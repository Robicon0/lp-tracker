"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

// Mobile-only hamburger trigger + dropdown menu. Reused across every nav
// variant (TerminalNavbar, TerminalNav, the homepage inline <nav>) so all
// pages have the same mobile navigation. Tailwind `md:hidden` on both the
// button and the overlay means desktop renders zero extra markup — no
// width or layout impact on >=768px.

const NAV_LINKS: { href: string; label: string }[] = [
  { href: "/",          label: "Home" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/analytics", label: "Analytics" },
  { href: "/about",     label: "About" },
];

const FONT     = "'JetBrains Mono','Courier New',monospace";
const GREEN    = "var(--accent)";
const BORDER   = "var(--line)";
const TEXT_MID = "var(--fg-muted)";

export default function MobileNavMenu() {
  const pathname = usePathname() ?? "/";
  const [open, setOpen] = useState(false);

  // Close on route change (covers programmatic nav, browser back, etc.)
  useEffect(() => setOpen(false), [pathname]);

  const isActive = (href: string) =>
    href === "/"
      ? pathname === "/"
      : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <>
      {/* Hamburger trigger. Tailwind `md:hidden` removes it from desktop
          entirely (display: none) — no inline `display: flex` could
          beat that because Tailwind utilities here win the cascade at
          md+. */}
      <button
        type="button"
        className="md:hidden flex items-center justify-center"
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          width: 44,
          height: 44,
          marginRight: 8,
          background: "transparent",
          border: "none",
          cursor: "pointer",
          padding: 0,
          flexShrink: 0,
        }}
      >
        {open ? (
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
            <line x1="3"  y1="3"  x2="17" y2="17" stroke={GREEN} strokeWidth="2" />
            <line x1="17" y1="3"  x2="3"  y2="17" stroke={GREEN} strokeWidth="2" />
          </svg>
        ) : (
          <svg width="22" height="16" viewBox="0 0 22 16" aria-hidden>
            <rect width="22" height="2" fill={GREEN} />
            <rect y="7"  width="22" height="2" fill={GREEN} />
            <rect y="14" width="22" height="2" fill={GREEN} />
          </svg>
        )}
      </button>

      {/* Dropdown overlay. `md:hidden` guarantees a desktop user who
          resizes from mobile back to desktop never sees an orphan open
          menu. position: fixed at top: 52 drops it directly below the
          52px nav. Backdrop tap closes; inner content stops propagation
          so taps on a link only trigger the link's own onClick. */}
      {open && (
        <div
          className="md:hidden"
          onClick={() => setOpen(false)}
          style={{
            position: "fixed",
            top: 52,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0, 0, 0, 0.92)",
            backdropFilter: "blur(2px)",
            WebkitBackdropFilter: "blur(2px)",
            zIndex: 9999,
            fontFamily: FONT,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--bg)",
              borderBottom: `1px solid ${BORDER}`,
              boxShadow: "0 8px 32px color-mix(in srgb, var(--accent) 5%, transparent)",
            }}
          >
            {NAV_LINKS.map((l) => {
              const active = isActive(l.href);
              return (
                <Link
                  key={l.label}
                  href={l.href}
                  onClick={() => setOpen(false)}
                  style={{
                    display: "block",
                    padding: "18px 28px",
                    fontSize: 16,
                    fontWeight: 700,
                    letterSpacing: "0.16em",
                    textTransform: "uppercase",
                    color:      active ? GREEN : TEXT_MID,
                    background: active ? "color-mix(in srgb, var(--accent) 5%, transparent)" : "transparent",
                    borderLeft: `3px solid ${active ? GREEN : "transparent"}`,
                    borderBottom: `1px solid ${BORDER}`,
                    textDecoration: "none",
                  }}
                >
                  {l.label}
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
