"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  CALCULATOR_LINKS,
  CALCULATOR_MENU_LABEL,
} from "../config/calculatorLinks";

/**
 * The "Calculator" nav item — a trigger plus a small dropdown, sitting beside
 * Analytics in every desktop nav.
 *
 * One component, three visual variants, because the site's navs are built three
 * different ways and a nav item has to look native to the bar it sits in:
 *   "tab"     — TerminalNavbar / TerminalNav: full-height cell with a right
 *               rule, 15px / 0.12em uppercase (their shared `tabBase`).
 *   "inline"  — HomeV2's home-page nav: same type, no cell borders.
 *   "emerald" — the older Tailwind Navbar on /wallet and /watched.
 *
 * The dropdown's ITEMS are not defined here; they come from
 * app/config/calculatorLinks.ts, so a second tool is a one-line addition there
 * and appears in all five nav surfaces at once.
 *
 * Opens on hover and on click (hover alone is unusable on touch, click alone is
 * a wasted affordance on a pointer). Closes on outside click, Escape, and
 * navigation.
 */

type Variant = "tab" | "inline" | "emerald";

export default function CalculatorMenu({
  variant = "tab",
}: {
  variant?: Variant;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  // Any Calculator destination counts as "on this section", so the trigger
  // reads as active on /clp-tracker and its sub-pages.
  const active = CALCULATOR_LINKS.some(
    (l) => pathname === l.href || pathname.startsWith(`${l.href}/`)
  );

  // Close on navigation. Without this the panel stays open over the new page,
  // since the nav itself never unmounts between routes.
  //
  // Adjusted during render rather than in an effect: React's documented
  // pattern for "reset state when a value changes", and the one the
  // react-hooks/set-state-in-effect rule asks for. Setting state while
  // rendering re-runs this component immediately, before anything is painted,
  // so the stale-open panel is never visible.
  const [pathAtOpen, setPathAtOpen] = useState(pathname);
  if (pathAtOpen !== pathname) {
    setPathAtOpen(pathname);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const terminalType: CSSProperties = {
    fontFamily: "var(--font-jetbrains-mono), monospace",
    fontSize: 15,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
  };

  const triggerStyle: CSSProperties =
    variant === "tab"
      ? {
          ...terminalType,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "0 22px",
          height: "100%",
          color: active ? "var(--fg)" : "var(--fg-muted)",
          borderRight: "1px solid var(--line)",
          background: "transparent",
          cursor: "pointer",
          transition: "color 0.15s, background 0.15s",
          position: "relative",
        }
      : variant === "inline"
        ? {
            ...terminalType,
            display: "flex",
            alignItems: "center",
            gap: 6,
            color: active ? "var(--fg)" : "var(--fg-subtle)",
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
            borderRadius: "var(--r-sm)",
            transitionDuration: "var(--t-fast)",
          }
        : {
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
          };

  return (
    <div
      ref={wrapRef}
      className={variant === "tab" ? "relative flex" : "relative"}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={triggerStyle}
        className={
          variant === "emerald"
            ? "text-emerald-300/80 hover:text-emerald-300 transition-colors"
            : "hover:text-[var(--fg)]"
        }
      >
        {CALCULATOR_MENU_LABEL}
        <span
          aria-hidden="true"
          style={{
            fontSize: 9,
            lineHeight: 1,
            transform: open ? "rotate(180deg)" : "none",
            transition: "transform 0.15s",
          }}
        >
          ▼
        </span>
        {variant === "tab" && active && (
          <span
            className="absolute left-0 right-0 h-px bg-[var(--accent)]"
            style={{
              bottom: -1,
              boxShadow:
                "0 0 8px color-mix(in srgb, var(--accent) 18%, transparent)",
            }}
          />
        )}
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            minWidth: 210,
            zIndex: 400,
            background: "var(--surface)",
            border: "1px solid var(--line-strong)",
            borderRadius: "var(--r-sm, 3px)",
            boxShadow: "0 18px 45px -8px rgba(0, 0, 0, 0.65)",
            padding: 4,
            marginTop: variant === "tab" ? 0 : 10,
          }}
        >
          {CALCULATOR_LINKS.map((l) => {
            const itemActive =
              pathname === l.href || pathname.startsWith(`${l.href}/`);
            return (
              <Link
                key={l.href}
                href={l.href}
                role="menuitem"
                onClick={() => setOpen(false)}
                className="block no-underline hover:bg-[var(--accent-surface)] hover:text-[var(--accent)]"
                style={{
                  fontFamily: "var(--font-jetbrains-mono), monospace",
                  fontSize: 13,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  padding: "10px 14px",
                  borderRadius: "var(--r-sm, 3px)",
                  color: itemActive ? "var(--accent)" : "var(--fg-muted)",
                  background: itemActive
                    ? "var(--accent-surface)"
                    : "transparent",
                  whiteSpace: "nowrap",
                }}
              >
                {l.label}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
