"use client";

import { motion, useReducedMotion } from "framer-motion";
import type { ReactNode } from "react";
import { revealParent, revealChild, VIEWPORT } from "./motion";

/**
 * Scroll-entry reveal. Wrap a section in <Reveal> and each child in
 * <RevealItem> to get the staggered rise-and-fade defined in ./motion.
 *
 * Reduced motion is honoured at the source, not just by CSS: when the OS asks
 * for less motion the variants collapse to a plain opacity swap with no
 * transform, so nothing slides. Content is never hidden as a result — the
 * `hidden` state always resolves to visible after mount.
 */
export function Reveal({
  children,
  className,
  as = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section";
}) {
  const reduce = useReducedMotion();
  const Comp = as === "section" ? motion.section : motion.div;

  return (
    <Comp
      className={className}
      variants={reduce ? undefined : revealParent}
      initial={reduce ? undefined : "hidden"}
      whileInView={reduce ? undefined : "visible"}
      viewport={VIEWPORT}
    >
      {children}
    </Comp>
  );
}

export function RevealItem({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const reduce = useReducedMotion();
  if (reduce) {
    return (
      <div className={className} style={style}>
        {children}
      </div>
    );
  }
  return (
    <motion.div className={className} style={style} variants={revealChild}>
      {children}
    </motion.div>
  );
}
