"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getActivePolicy, pingApi, POLICY_CHANGED_EVENT } from "@/lib/api";

const POLL_MS = 30_000;

const IST_TIME = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

type ApiState = "checking" | "online" | "offline";

/** Header status: IST market clock, active DSM policy and API reachability. */
export default function StatusBar() {
  const [clock, setClock] = useState<string | null>(null);
  const [apiState, setApiState] = useState<ApiState>("checking");
  const [policy, setPolicy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const tickClock = () => setClock(IST_TIME.format(new Date()));
    const refresh = async () => {
      const online = await pingApi();
      if (cancelled) return;
      setApiState(online ? "online" : "offline");
      if (!online) return;
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
      <span className="flex items-center gap-1.5" role="status">
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            apiState === "online"
              ? "bg-[#00B398]"
              : apiState === "offline"
                ? "bg-red-400"
                : "bg-white/40"
          }`}
        />
        {apiState === "online"
          ? "API online"
          : apiState === "offline"
            ? "API offline"
            : "Connecting…"}
      </span>
    </div>
  );
}
