import type { Variants } from "framer-motion";

/**
 * Shared motion vocabulary for the home page.
 *
 * One easing curve and one timing scale across every section, so motion reads
 * as a single system rather than per-component improvisation. Values come from
 * the ui-ux-pro-max design system for the "Modern Dark (Cinema Mobile)" style:
 * expo.out bezier, 300–450ms, 60ms stagger.
 *
 * Motion here always carries meaning — it marks section entry and content
 * arrival order. Nothing animates purely for decoration, and every consumer
 * pairs these with a reduced-motion check.
 */

/** expo.out — GSAP's cubic-bezier(0.16, 1, 0.3, 1). Fast out, long settle. */
export const EXPO_OUT = [0.16, 1, 0.3, 1] as const;

export const DUR = {
  micro: 0.15,
  fast: 0.3,
  base: 0.45,
  slow: 0.7,
} as const;

/** Parent: staggers children on scroll entry. Pair with `revealChild`. */
export const revealParent: Variants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.06, delayChildren: 0.04 },
  },
};

/** Child: the canonical rise-and-fade. 16px is enough to read as motion. */
export const revealChild: Variants = {
  hidden: { opacity: 0, y: 16 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: DUR.base, ease: EXPO_OUT },
  },
};

/** Viewport config: fire once, slightly before the element is fully on screen. */
export const VIEWPORT = { once: true, margin: "-80px" } as const;
