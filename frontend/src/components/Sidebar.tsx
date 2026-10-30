"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOutAction } from "@/app/(app)/actions";
import { sidebarCookie } from "@/lib/sidebar";

const sections = [
  {
    label: "TRADING",
    items: [
      {
        href: "/workstation",
        label: "Workstation",
        icon: (
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1"
            />
          </svg>
        ),
      },
      {
        href: "/blotter",
        label: "Blotter",
        icon: (
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"
            />
          </svg>
        ),
      },
      {
        href: "/risk",
        label: "Risk Assessment",
        icon: (
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z"
            />
          </svg>
        ),
      },
    ],
  },
  {
    label: "DATA PIPELINE",
    items: [
      {
        href: "/sync",
        label: "Market Data Sync",
        icon: (
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
        ),
      },
    ],
  },
  {
    label: "MODEL LAB",
    items: [
      {
        href: "/forecast",
        label: "Model Training",
        icon: (
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
            />
          </svg>
        ),
      },
      {
        href: "/backtest",
        label: "Backtest",
        icon: (
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
        ),
      },
    ],
  },
  {
    label: "ANALYSIS",
    items: [
      {
        href: "/analysis",
        label: "Post-Market",
        icon: (
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
            />
          </svg>
        ),
      },
    ],
  },
  {
    label: "COMPLIANCE",
    items: [
      {
        href: "/policy",
        label: "DSM Policy",
        icon: (
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
            />
          </svg>
        ),
      },
    ],
  },
];

function initials(name: string): string {
  const words = name.split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2);
  return letters.toUpperCase();
}

type TipContent = { text: string; hint?: string };
type Tip = TipContent & { top: number; left: number };

function shortcutLabel(): string {
  return /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘B" : "Ctrl+B";
}

export default function Sidebar({
  user,
  defaultCollapsed,
}: {
  user: { id: string; name: string };
  defaultCollapsed: boolean;
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  // Collapsed, the labels give way to tooltips. They are fixed to the viewport because the
  // nav scrolls, which would clip anything positioned past its edge.
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    document.cookie = sidebarCookie(collapsed);
  }, [collapsed]);

  const toggle = useCallback(() => {
    setTip(null);
    setCollapsed((c) => !c);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "b" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggle]);

  const showTip = (content: () => TipContent) => (e: React.SyntheticEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setTip({ ...content(), top: r.top + r.height / 2, left: r.right + 12 });
  };
  const hideTip = () => setTip(null);
  const tipHandlers = (content: () => TipContent) => ({
    onMouseEnter: showTip(content),
    onMouseLeave: hideTip,
    onFocus: showTip(content),
    onBlur: hideTip,
  });
  const railTip = (text: string) => (collapsed ? tipHandlers(() => ({ text })) : {});
  // The shortcut is read from the browser, so it is only known once the tooltip opens.
  const toggleTip = () => ({
    text: collapsed ? "Expand sidebar" : "Collapse sidebar",
    hint: shortcutLabel(),
  });

  return (
    <aside
      className={`${collapsed ? "w-14" : "w-56"} bg-[var(--bg-secondary)] border-r border-[var(--border)] flex flex-col shrink-0 overflow-hidden transition-[width] duration-200 ease-out motion-reduce:transition-none`}
    >
      <nav
        id="app-sidebar-nav"
        aria-label="Main"
        onScroll={hideTip}
        className="flex-1 px-2 py-3 space-y-4 overflow-y-auto overflow-x-hidden"
      >
        {sections.map((section, i) => (
          <div key={section.label}>
            {/* Collapsed, the heading keeps its height, so the icons stay where they were. */}
            <p className="px-3 mb-1 h-3.5 flex items-center text-[9px] font-bold tracking-widest text-gray-400 uppercase whitespace-nowrap">
              {!collapsed ? (
                section.label
              ) : (
                <>
                  <span className="sr-only">{section.label}</span>
                  {i > 0 && <span aria-hidden className="w-4 h-px bg-gray-200" />}
                </>
              )}
            </p>
            <div className="space-y-0.5">
              {section.items.map((item) => {
                const isActive = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={isActive ? "page" : undefined}
                    {...railTip(item.label)}
                    className={`flex items-center gap-2.5 px-3 py-2 rounded-md border text-xs whitespace-nowrap transition-colors ${
                      isActive
                        ? "bg-[#EEF5FB] text-[#006DAE] border-[#006DAE]/20 font-medium"
                        : "border-transparent text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                    }`}
                  >
                    <span
                      className={isActive ? "text-[#006DAE]" : "text-gray-400"}
                    >
                      {item.icon}
                    </span>
                    <span className={collapsed ? "sr-only" : undefined}>{item.label}</span>
                    {isActive && !collapsed && (
                      <span className="ml-auto w-1 h-1 bg-[var(--brand-teal)] rounded-full" />
                    )}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="px-2 pb-2">
        <button
          type="button"
          onClick={toggle}
          aria-controls="app-sidebar-nav"
          aria-expanded={!collapsed}
          aria-keyshortcuts="Meta+B Control+B"
          {...tipHandlers(toggleTip)}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-md border border-transparent text-xs text-gray-500 whitespace-nowrap hover:bg-gray-100 hover:text-gray-900 transition-colors"
        >
          <svg
            aria-hidden
            className={`w-4 h-4 shrink-0 text-gray-400 transition-transform duration-200 motion-reduce:transition-none ${collapsed ? "rotate-180" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
          </svg>
          <span className={collapsed ? "sr-only" : undefined}>
            {collapsed ? "Expand sidebar" : "Collapse"}
          </span>
        </button>
      </div>

      <div
        className={`border-t border-[var(--border)] py-3 flex items-center ${
          collapsed ? "flex-col gap-2 px-2" : "gap-2.5 px-3"
        }`}
      >
        <span
          aria-hidden
          {...railTip(`${user.name} · ${user.id}`)}
          className="w-7 h-7 shrink-0 rounded-full bg-[#EEF5FB] text-[#006DAE] text-[10px] font-semibold flex items-center justify-center"
        >
          {initials(user.name)}
        </span>
        <div className={collapsed ? "sr-only" : "min-w-0 flex-1"}>
          <p className="text-xs font-medium text-gray-800 truncate">{user.name}</p>
          <p className="text-[10px] text-gray-400 truncate" title={user.id}>
            {user.id}
          </p>
        </div>
        <form action={signOutAction}>
          <button
            type="submit"
            title={collapsed ? undefined : "Sign out"}
            aria-label="Sign out"
            {...railTip("Sign out")}
            className="p-1.5 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
              />
            </svg>
          </button>
        </form>
      </div>

      {tip && (
        <span
          aria-hidden
          style={{ top: tip.top, left: tip.left }}
          className="fixed z-50 -translate-y-1/2 pointer-events-none flex items-center gap-2 whitespace-nowrap rounded-md bg-gray-900 px-2 py-1 text-[11px] font-medium text-white shadow-lg"
        >
          {tip.text}
          {tip.hint && <kbd className="font-sans text-[10px] text-gray-400">{tip.hint}</kbd>}
        </span>
      )}
    </aside>
  );
}
