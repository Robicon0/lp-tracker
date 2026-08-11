"use client";

import { motion, useReducedMotion } from "framer-motion";
import { FloatingPaths } from "@/components/ui/background-paths";

/**
 * Atmospheric backdrop for the hero.
 *
 * Three stacked layers, cheapest first:
 *   1. a static grid + vignette (pure CSS gradients, zero runtime cost)
 *   2. two slow-oscillating ambient glow blobs
 *   3. the framer-motion path field, dialled well back
 *
 * Everything animates via `transform` and `opacity` only — never width/height
 * or filter — so the whole backdrop composites on the GPU and cannot cause
 * layout thrash or CLS. The blur is baked into a static radial gradient rather
 * than a `filter: blur()`, which is what makes layer 2 essentially free.
 *
 * The base is var(--bg), not var(--bg): the design system flags pure black on OLED
 * for smear and for flattening every layer above it into the same plane.
 */
export default function AmbientBackdrop({
  variant = "hero",
}: {
  /**
   * "hero" — the original: absolutely positioned inside a `relative` section,
   *          sized to that section. Home page behaviour, unchanged.
   * "page"  — FIXED to the viewport behind the whole page, for the app pages
   *          (dashboard / analytics / about / …) which previously painted a
   *          flat `var(--bg)`.
   *
   * `page` is fixed rather than absolute for two reasons: an absolute layer
   * would stretch to the full document height (2,854px on the dashboard at
   * 390px wide), which scales the blobs and grid into something quite
   * different from the hero; and a fixed layer paints once and never reflows
   * as the page scrolls.
   *
   * z-index -1 (vs 0 for the hero) is what lets this drop in WITHOUT touching
   * any page's content markup. At z-index 0 it would paint ABOVE every
   * non-positioned element on the page — positioned z-0 elements paint in a
   * later step than in-flow content — so every content block would need
   * `position: relative` added. At -1 it sits behind everything, and since
   * `body` already paints `var(--bg)`, the page root just needs a transparent
   * background for it to show through.
   */
  variant?: "hero" | "page";
} = {}) {
  const reduce = useReducedMotion();
  const isPage = variant === "page";

  const blob = (color: string) =>
    `radial-gradient(circle at center, ${color} 0%, transparent 68%)`;

  return (
    <div
      aria-hidden
      data-hero-fx
      className={`pointer-events-none ${isPage ? "fixed" : "absolute"} inset-0 overflow-hidden select-none`}
      style={{ zIndex: isPage ? -1 : 0 }}
    >
      {/* 1a. Grid — establishes the engineering/terminal register without the
             noise of a full scanline field. */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            "linear-gradient(color-mix(in srgb, var(--line) 55%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--line) 55%, transparent) 1px, transparent 1px)",
          backgroundSize: "72px 72px",
          // Same repositioning logic as the blobs below: the hero anchors this
          // at 30%/20%, which on an app page is underneath the sidebar.
          maskImage: isPage
            ? "radial-gradient(120% 95% at 55% 25%, black 0%, transparent 78%)"
            : "radial-gradient(120% 90% at 30% 20%, black 0%, transparent 75%)",
          WebkitMaskImage: isPage
            ? "radial-gradient(120% 95% at 55% 25%, black 0%, transparent 78%)"
            : "radial-gradient(120% 90% at 30% 20%, black 0%, transparent 75%)",
        }}
      />

      {/* 2. Ambient light blobs — the depth cue. Very low alpha; they read as
             atmosphere, never as shapes. */}
      {/* PLACEMENT, page variant — this is the whole reason the first attempt
          shipped an invisible glow. The hero blob is centred OFF-SCREEN
          (top -18%, left -12%), which works behind a hero because the top-left
          of that section is empty space. On an app page the same coordinates
          put the brightest part of the glow off-canvas, and what little
          remained sat behind the opaque 192px sidebar — so the page still read
          flat black. The page variant therefore pulls both blobs INTO the
          content area and enlarges them, and lifts the accent alpha, because a
          blob spread over 92vw is far more diffuse than the hero's 58vw. */}
      <motion.div
        className="absolute"
        style={{
          top: isPage ? "-28%" : "-18%",
          left: isPage ? "6%" : "-12%",
          width: isPage ? "92vw" : "58vw",
          height: isPage ? "92vw" : "58vw",
          background: blob(
            isPage
              ? "color-mix(in srgb, var(--accent-glow) 215%, transparent)"
              : "var(--accent-glow)",
          ),
        }}
        animate={
          reduce ? undefined : { x: [0, 40, -20, 0], y: [0, -30, 20, 0] }
        }
        transition={{ duration: 34, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute"
        style={{
          bottom: isPage ? "-30%" : "-24%",
          right: isPage ? "2%" : "-10%",
          width: isPage ? "72vw" : "50vw",
          height: isPage ? "72vw" : "50vw",
          background: blob(
            isPage
              ? "color-mix(in srgb, var(--info) 26%, transparent)"
              : "color-mix(in srgb, var(--info) 14%, transparent)",
          ),
        }}
        animate={
          reduce ? undefined : { x: [0, -34, 18, 0], y: [0, 26, -18, 0] }
        }
        transition={{ duration: 41, repeat: Infinity, ease: "easeInOut" }}
      />

      {/* 3. Path field — HERO ONLY.
             Deliberately not rendered for `page`: on the app pages the diagonal
             lines read as noise behind dense data surfaces rather than as the
             texture they are behind a hero headline, so those pages take the
             gradient/glow alone (owner decision, 2026-08-11). Skipping it also
             means the app pages carry NO animated SVG — the ambient blobs are
             two transform-animated gradients, and nothing else runs. */}
      {!isPage && (
        <div
          className="absolute inset-0"
          style={{
            opacity: 0.3,
            maskImage:
              "radial-gradient(100% 80% at 45% 55%, black 10%, transparent 82%)",
            WebkitMaskImage:
              "radial-gradient(100% 80% at 45% 55%, black 10%, transparent 82%)",
          }}
        >
          <FloatingPaths position={1} className="text-[var(--accent)]" />
          <FloatingPaths position={-1} className="text-[var(--info)]" />
        </div>
      )}

      {/* 1b. Vignette — reseats the edges into the page background so no layer
             ends on a visible rectangle. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            // The hero's vignette reseats a SECTION into the page around it.
            // A viewport-fixed layer has no surrounding page to blend into, and
            // that aggressive falloff was swallowing the glow before it cleared
            // the sidebar — so the page variant fades later and stops short of
            // fully opaque.
            isPage
              ? "radial-gradient(150% 130% at 40% 25%, transparent 62%, var(--bg) 100%)"
              : "radial-gradient(130% 110% at 50% 30%, transparent 40%, var(--bg) 100%)",
        }}
      />
    </div>
  );
}
