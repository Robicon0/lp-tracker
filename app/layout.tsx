import Providers from "./providers";
import { Geist, Geist_Mono, JetBrains_Mono, Space_Grotesk, Inter } from "next/font/google";
import { Analytics } from "@vercel/analytics/react";
import FloatingFeedback from "./components/FloatingFeedback";
import FeedbackTab from "./components/FeedbackTab";
import WalletRestoreEffect from "./components/WalletRestoreEffect";
import ThemeScript from "./components/theme/ThemeScript";
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

// Display + body faces for the redesigned home page. The ui-ux-pro-max design
// system recommends the Space Grotesk / Inter / JetBrains Mono triad for DeFi
// and fintech surfaces: Space Grotesk carries display headlines, Inter carries
// prose, JetBrains Mono stays reserved for data, labels, and terminal chrome.
// Declaring them here is additive — nothing renders differently until a
// component opts in via var(--font-space-grotesk) / var(--font-inter).
const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
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
