import type { Metadata } from "next";
import "./clp-tracker.css";
import { Sidebar } from "./components/Sidebar";

/* Nested layout — NOT a root layout. <html> and <body> belong to
 * app/layout.tsx and must not be repeated here; this only contributes the
 * section's own chrome (sidebar + main) inside the host document.
 *
 * The font setup that lived here upstream (next/font Geist + Geist_Mono, and
 * the className that carried their CSS variables) is gone on purpose: the host
 * layout already loads Geist and declares --font-geist-sans / --font-geist-mono
 * on <body>, so those variables are inherited. Loading the same faces a second
 * time would ship duplicate font files.
 *
 * data-app="clp-tracker" is what scopes clp-tracker.css. Every colour variable
 * this section uses is defined on this element rather than :root, so nothing
 * bleeds out to the rest of DefiDesh and nothing bleeds in.
 */

export const metadata: Metadata = {
  title: "CLP Tracker — LP Position Manager",
  description:
    "Track your DeFi LP positions, fee claims, and P&L in one place",
};

export default function ClpTrackerLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div
      data-app="clp-tracker"
      className="flex min-h-screen flex-col md:flex-row"
    >
      <Sidebar />
      {/* THE one width container for every CLP page — Dashboard, Positions,
       * Fee Claims, Transfers, Total P&L, all of it. Widening happens here and
       * nowhere else; a per-page max-width would drift.
       *
       * max-w-6xl (1152px) boxed the content into the middle of a wide screen
       * and, worse, was NARROWER than the Fee Claims table needs (1268px), so
       * that table scrolled horizontally and clipped its Tx and Actions columns
       * on a monitor with room to spare. 1600px clears the table with slack
       * while still capping line length on an ultrawide, where a 2200px-wide
       * row would be a chore to read across.
       *
       * The extra right padding from 2xl up is NOT decoration: the global
       * FeedbackTab (app/layout.tsx) is fixed to the viewport's right edge,
       * rotated, ~31px wide and vertically centred — so it sits directly over
       * table rows. It is shared by every DefiDesh page, so CLP reserves a
       * gutter for it here instead of moving a global element. Measured at
       * 1920: content ends at 1856, the tab starts at 1890.
       *
       * No font size changes anywhere — this is width only.
       */}
      {/* min-w-0 is load-bearing, not tidying: a flex child defaults to
       * min-width:auto, so the Fee Claims table's 1268px min-content width
       * pushes <main> wider than its flex basis and scrolls the WHOLE PAGE
       * sideways on a laptop. max-w-6xl used to mask that by clamping below the
       * table's width; widening the cap exposed it. With min-w-0 the table's
       * own wrapper scrolls internally again, which is the intended behaviour.
       */}
      <main className="min-w-0 flex-1 px-6 py-8 md:px-10 md:py-10 2xl:pr-16">
        <div className="mx-auto w-full max-w-[1600px]">{children}</div>
      </main>
    </div>
  );
}
