import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "EnergyTrader",
  description:
    "Bidding workstation for Indian power exchanges: price forecasting, bid optimization, pre-trade checks and post-market review.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
