import type { ReactNode } from "react";

/**
 * The page's one horizontal rhythm.
 *
 * Every section on the site measures its content against the SAME max-width
 * and the SAME gutter, both read from tokens (--maxw / --gutter). Before this,
 * sections used `px-4 sm:px-12`, `px-8 sm:px-12`, and `px-4 sm:px-10`
 * interchangeably, so section edges were off by up to 8px from each other —
 * which is precisely the kind of misalignment that reads as "not quite
 * finished" without a viewer being able to name why.
 *
 * `bleed` keeps the full-bleed border/background but still aligns the inner
 * content to the same rail, which is how full-width divider rules stay flush
 * with a centred column.
 */
export function Shell({
  children,
  className = "",
  innerClassName,
  bleed = false,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  /**
   * Classes for the railed inner column itself (not the full-bleed wrapper).
   * Needed when the rail must carry layout of its own — e.g. the price ticker,
   * whose inner row is `flex h-full` while its border/background stay
   * edge-to-edge. Without this the rail tokens would have to be duplicated
   * inline at the call site, which is the exact drift this file exists to stop.
   */
  innerClassName?: string;
  bleed?: boolean;
  as?: "div" | "section" | "header" | "footer" | "nav";
}) {
  const inner = (
    <div
      className={innerClassName ?? (bleed ? "" : className)}
      style={{
        maxWidth: "var(--maxw)",
        marginInline: "auto",
        paddingInline: "var(--gutter)",
        width: "100%",
      }}
    >
      {children}
    </div>
  );

  if (!bleed) return <Tag className={className}>{inner}</Tag>;
  return <Tag className={className}>{inner}</Tag>;
}

/**
 * Section eyebrow. One rule, one rhythm, every section.
 */
export function SectionLabel({
  children,
  meta,
}: {
  children: string;
  meta?: string;
}) {
  return (
    <div
      className="flex items-center gap-3 uppercase"
      style={{
        fontFamily: "var(--font-jetbrains-mono), monospace",
        fontSize: 11,
        letterSpacing: "0.22em",
        color: "var(--fg-subtle)",
        marginBottom: "var(--space-2xl)",
      }}
    >
      <span style={{ color: "var(--accent)" }}>//</span>
      <span>{children}</span>
      <span
        className="flex-1"
        style={{ height: 1, background: "var(--line)" }}
      />
      {meta ? <span style={{ letterSpacing: "0.1em" }}>{meta}</span> : null}
    </div>
  );
}
