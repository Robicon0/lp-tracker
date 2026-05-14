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
  openGraph: {
    title: "DefiDesh",
    siteName: "DefiDesh",
    description: "Track your DeFi liquidity positions across multiple chains.",
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
