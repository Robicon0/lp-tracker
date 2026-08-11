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
export default function AmbientBackdrop() {
  const reduce = useReducedMotion();

  const blob = (color: string) =>
    `radial-gradient(circle at center, ${color} 0%, transparent 68%)`;

  return (
    <div
      aria-hidden
      data-hero-fx
      className="pointer-events-none absolute inset-0 overflow-hidden select-none"
      style={{ zIndex: 0 }}
    >
      {/* 1a. Grid — establishes the engineering/terminal register without the
             noise of a full scanline field. */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            "linear-gradient(color-mix(in srgb, var(--line) 55%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--line) 55%, transparent) 1px, transparent 1px)",
          backgroundSize: "72px 72px",
          maskImage:
            "radial-gradient(120% 90% at 30% 20%, black 0%, transparent 75%)",
          WebkitMaskImage:
            "radial-gradient(120% 90% at 30% 20%, black 0%, transparent 75%)",
        }}
      />

      {/* 2. Ambient light blobs — the depth cue. Very low alpha; they read as
             atmosphere, never as shapes. */}
      <motion.div
        className="absolute"
        style={{
          top: "-18%",
          left: "-12%",
          width: "58vw",
          height: "58vw",
          background: blob("var(--accent-glow)"),
        }}
        animate={
          reduce ? undefined : { x: [0, 40, -20, 0], y: [0, -30, 20, 0] }
        }
        transition={{ duration: 34, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute"
        style={{
          bottom: "-24%",
          right: "-10%",
          width: "50vw",
          height: "50vw",
          background: blob("color-mix(in srgb, var(--info) 14%, transparent)"),
        }}
        animate={
          reduce ? undefined : { x: [0, -34, 18, 0], y: [0, 26, -18, 0] }
        }
        transition={{ duration: 41, repeat: Infinity, ease: "easeInOut" }}
      />

      {/* 3. Path field — pulled back to a whisper so it reads as texture behind
             the headline instead of competing with it. */}
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

      {/* 1b. Vignette — reseats the edges into the page background so no layer
             ends on a visible rectangle. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(130% 110% at 50% 30%, transparent 40%, var(--bg) 100%)",
        }}
      />
    </div>
  );
}
