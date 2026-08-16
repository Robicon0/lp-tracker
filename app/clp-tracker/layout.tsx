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
      <main className="flex-1 px-6 py-8 md:px-10 md:py-10">
        <div className="mx-auto w-full max-w-6xl">{children}</div>
      </main>
    </div>
  );
}
