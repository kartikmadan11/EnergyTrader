import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import BrandMark from "@/components/BrandMark";
import Sidebar from "@/components/Sidebar";
import StatusBar from "@/components/StatusBar";
import { SIDEBAR_COOKIE, isSidebarCollapsed } from "@/lib/sidebar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // The proxy already redirects signed-out visitors; this keeps the pages safe without it.
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const { id, name } = session.user;
  const collapsed = isSidebarCollapsed((await cookies()).get(SIDEBAR_COOKIE)?.value);

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-[var(--bg-primary)] text-gray-900">
      <header className="header-gradient h-12 flex items-center px-5 shrink-0 z-20 shadow-lg">
        <Link
          href="/workstation"
          className="flex items-center gap-2 text-white text-sm font-semibold tracking-wide"
        >
          <BrandMark className="w-5 h-5 rounded-[5px] ring-1 ring-white/25" />
          EnergyTrader
        </Link>
        <StatusBar />
      </header>

      <div className="flex flex-1 overflow-hidden">
        <Sidebar user={{ id, name: name || id }} defaultCollapsed={collapsed} />
        <main className="flex-1 overflow-y-auto p-6 bg-[var(--bg-primary)]">
          <div className="max-w-[1400px] mx-auto">{children}</div>
        </main>
      </div>
    </div>
  );
}
