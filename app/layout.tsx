import Providers from "./providers";
import localFont from "next/font/local";
import { Analytics } from "@vercel/analytics/react";
import FloatingFeedback from "./components/FloatingFeedback";
import FeedbackTab from "./components/FeedbackTab";
import WalletRestoreEffect from "./components/WalletRestoreEffect";
import ThemeScript from "./components/theme/ThemeScript";
import "./globals.css";

// Fonts are SELF-HOSTED (app/fonts, latin variable woff2 from Fontsource,
// SIL OFL 1.1). With next/font/google every build downloaded them from Google,
// and a failed download failed the whole build (the first build of 5026c79 on
// 2026-10-18). Same families, same CSS variables; the variable files cover
// every weight the old setup asked for.
const geistSans = localFont({
  src: "./fonts/geist-latin-wght-normal.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
  display: "swap",
});

const geistMono = localFont({
  src: "./fonts/geist-mono-latin-wght-normal.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
});

const jetbrainsMono = localFont({
  src: "./fonts/jetbrains-mono-latin-wght-normal.woff2",
  variable: "--font-jetbrains-mono",
  weight: "100 800",
  display: "swap",
});

const spaceGrotesk = localFont({
  src: "./fonts/space-grotesk-latin-wght-normal.woff2",
  variable: "--font-space-grotesk",
  weight: "300 700",
  display: "swap",
});

const inter = localFont({
  src: "./fonts/inter-latin-wght-normal.woff2",
  variable: "--font-inter",
  weight: "100 900",
  display: "swap",
});

export const metadata = {
  title: "DefiDesh",
  description: "Track your DeFi liquidity positions across multiple chains — Ethereum, Solana, Sui, and more.",
  // Browser tab + iOS home-screen icons are auto-discovered by Next.js from
  // the file-system convention: `app/favicon.ico`, `app/icon.png`, and
  // `public/apple-touch-icon.png` (which iOS finds at the standard
  // `/apple-touch-icon.png` path). NO `metadata.icons` block here — adding
  // one creates duplicate / conflicting <link> tags. To rebrand: replace
  // the source PNGs in `app/` (favicon.ico, icon.png) and `public/`.
  openGraph: {
    title: "DefiDesh",
    description: "Track your DeFi liquidity positions across multiple chains.",
    url: "https://defidesh.com",
    siteName: "DefiDesh",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "DefiDesh — DeFi Position Tracker",
      },
    ],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "DefiDesh",
    description: "Track your DeFi liquidity positions across multiple chains.",
    images: ["/og-image.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Pre-paint theme resolution — must stay the first thing in <head>. */}
        <ThemeScript />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${jetbrainsMono.variable} ${spaceGrotesk.variable} ${inter.variable} antialiased`}
        suppressHydrationWarning={true}
      >
        <Providers>
          <WalletRestoreEffect />
          {children}
          {/* FloatingFeedback provides the modal logic; its round launcher is
              hidden globally via globals.css so the rotated FeedbackTab below
              is the sole user-facing affordance on every page (matching the
              homepage). FeedbackTab triggers FloatingFeedback's launcher
              programmatically via document.querySelector. */}
          <FloatingFeedback />
          <FeedbackTab />
        </Providers>
        {/* Vercel Analytics — pageview tracking. Outside <Providers> because
            it doesn't need wagmi / Solana / Sui context. Renders nothing
            visible; only injects the tracking script via /_vercel/insights. */}
        <Analytics />
      </body>
    </html>
  );
}
