import type { Metadata } from "next";
import "./globals.css";
import Sidebar from "@/components/Sidebar";
import StatusBar from "@/components/StatusBar";

export const metadata: Metadata = {
  title: "EnergyTrader",
  description:
    "Bidding workstation for Indian power exchanges: price forecasting, bid optimization, pre-trade checks and post-market review.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-[var(--bg-primary)] text-gray-900">
        <div className="flex flex-col h-screen overflow-hidden">
          <header className="header-gradient h-12 flex items-center px-5 shrink-0 z-20 shadow-lg">
            <span className="text-white text-sm font-semibold tracking-wide">EnergyTrader</span>
            <StatusBar />
          </header>

          <div className="flex flex-1 overflow-hidden">
            <Sidebar />
            <main className="flex-1 overflow-y-auto p-6 bg-[var(--bg-primary)]">
              <div className="max-w-[1400px] mx-auto">{children}</div>
            </main>
          </div>
        </div>
      </body>
    </html>
  );
}
