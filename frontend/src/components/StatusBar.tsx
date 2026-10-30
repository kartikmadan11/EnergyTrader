"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getActivePolicy, POLICY_CHANGED_EVENT } from "@/lib/api";

const POLL_MS = 30_000;

const IST_TIME = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Header status: IST market clock and the active DSM policy. */
export default function StatusBar() {
  const [clock, setClock] = useState<string | null>(null);
  const [policy, setPolicy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const tickClock = () => setClock(IST_TIME.format(new Date()));
    const refresh = async () => {
      try {
        const active = await getActivePolicy();
        if (!cancelled) setPolicy(active.name);
      } catch {
        if (!cancelled) setPolicy(null);
      }
    };

    tickClock();
    refresh();
    const clockTimer = setInterval(tickClock, 10_000);
    const pollTimer = setInterval(refresh, POLL_MS);
    window.addEventListener(POLICY_CHANGED_EVENT, refresh);
    return () => {
      cancelled = true;
      clearInterval(clockTimer);
      clearInterval(pollTimer);
      window.removeEventListener(POLICY_CHANGED_EVENT, refresh);
    };
  }, []);

  return (
    <div className="ml-auto flex items-center gap-5 text-xs text-white/70">
      {clock && (
        <span className="hidden sm:block tabular-nums" title="Indian Standard Time">
          {clock} IST
        </span>
      )}
      {policy && (
        <Link
          href="/policy"
          className="hidden md:flex items-center gap-1.5 hover:text-white transition-colors"
          title="Active DSM policy"
        >
          <span className="text-white/50">DSM policy</span>
          <span className="text-white/90 font-medium">{policy}</span>
        </Link>
      )}
    </div>
  );
}
