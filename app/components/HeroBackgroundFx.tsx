"use client";

import { FloatingPaths } from "@/components/ui/background-paths";

/**
 * Decorative animated path field for the home hero.
 *
 * LOCAL-ONLY BY DEFAULT. The home page renders this only when
 * `NEXT_PUBLIC_HERO_FX === "1"`, which is set in `.env.local` and NOT in
 * Vercel — so defidesh.com is byte-identical to today until that env var is
 * deliberately added in the Vercel dashboard.
 *
 * Purely presentational: no wallet reads, no position data, no P&L surface.
 * `pointer-events-none` + `aria-hidden` keep it out of the interaction and
 * accessibility trees, so the hero CTAs and HeroWalletConnect behave exactly
 * as before.
 */
export default function HeroBackgroundFx() {
  return (
    <div
      aria-hidden
      data-hero-fx
      className="pointer-events-none absolute inset-0 overflow-hidden select-none"
      style={{
        // Keeps the paths behind every hero child without touching their
        // stacking: the section's own content is z-10 via `relative z-10`.
        zIndex: 0,
        // Feathered edges so the field dissolves into the black terminal
        // background instead of ending on a hard rectangle.
        maskImage:
          "radial-gradient(120% 100% at 50% 40%, black 35%, transparent 100%)",
        WebkitMaskImage:
          "radial-gradient(120% 100% at 50% 40%, black 35%, transparent 100%)",
        opacity: 0.55,
      }}
    >
      <FloatingPaths position={1} className="text-[var(--accent)]" />
      <FloatingPaths position={-1} className="text-[var(--info)]" />
    </div>
  );
}
