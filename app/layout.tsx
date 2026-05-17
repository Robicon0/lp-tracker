import Providers from "./providers";
import { Geist, Geist_Mono, JetBrains_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/react";
import FloatingFeedback from "./components/FloatingFeedback";
import FeedbackTab from "./components/FeedbackTab";
import WalletRestoreEffect from "./components/WalletRestoreEffect";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
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
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${jetbrainsMono.variable} antialiased`}
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
