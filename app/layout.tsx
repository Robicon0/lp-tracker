import Providers from "./providers";
import { Geist, Geist_Mono, JetBrains_Mono } from "next/font/google";
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
  // All icon / OG image assets are served from /public — never link to
  // external URLs. Update the files in /public to change branding; the
  // paths below stay stable.
  icons: {
    icon: "/Logo.png",
    shortcut: "/Logo.png",
    apple: "/apple-touch-icon.png",
  },
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
      </body>
    </html>
  );
}
