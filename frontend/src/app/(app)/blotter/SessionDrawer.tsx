"use client";

import { useEffect, useRef, useState } from "react";
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  errorMessage,
  getBlotterSession,
  type BlotterBlock,
  type BlotterDetail,
  type BlotterEvent,
  type BlotterRow,
} from "@/lib/api";
import { blockToTime, formatINR } from "@/lib/utils";
import { ACTION_LABEL, SEGMENT_STYLE, STATUS, VERDICT, deliveryDate, mwh, percent, price, submittedAt } from "./format";

const TOOLTIP_STYLE = {
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "8px",
  fontSize: "12px",
  color: "#1e293b",
  boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
};

const RESULT_COLOR = { cleared: "#00B398", missed: "#F87171", pending: "#CBD5E1" };

type Loaded = { id: string; detail: BlotterDetail } | { id: string; error: string };

interface SessionDrawerProps {
  sessionId: string;
  /** The session's row in the blotter, when it is in the loaded list. */
  row: BlotterRow | null;
  /** Where the session sits in the loaded list, for stepping through it. */
  position: { index: number; count: number } | null;
  onStep: (delta: number) => void;
  onClose: () => void;
}

const typing = (target: EventTarget) =>
  target instanceof HTMLElement && target.closest("input, select, textarea, [contenteditable]") !== null;

export default function SessionDrawer({ sessionId, row, position, onStep, onClose }: SessionDrawerProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [copied, setCopied] = useState(false);

  // Reload when the blotter sees the session's clearing results change.
  const revision = row ? `${row.status}:${row.priced_blocks}` : "";

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
    closeButton.current?.focus();
  }, []);

  useEffect(() => {
    let current = true;
    getBlotterSession(sessionId).then(
      (detail) => {
        if (current) setLoaded({ id: sessionId, detail });
      },
      (e) => {
        if (current) setLoaded({ id: sessionId, error: errorMessage(e, "Could not load this session.") });
      },
    );
    return () => {
      current = false;
    };
  }, [sessionId, revision, attempt]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const view = loaded?.id === sessionId ? loaded : null;
  const session = view && "detail" in view ? view.detail.session : row;
  const status = session ? STATUS[session.status] : null;
  const canPrev = position !== null && position.index > 0;
  const canNext = position !== null && position.index < position.count - 1;

  const copyId = () => {
    navigator.clipboard.writeText(sessionId).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby="session-title"
      onClose={onClose}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog itself; the panel covers the rest.
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === "j" && canNext) onStep(1);
        if (e.key === "k" && canPrev) onStep(-1);
      }}
      className="drawer-in m-0 ml-auto h-dvh max-h-dvh w-full max-w-[640px] overflow-hidden bg-white p-0 shadow-2xl backdrop:bg-gray-900/25"
    >
      <div className="flex h-full flex-col">
        <header className="flex items-start justify-between gap-4 border-b border-gray-200 px-5 py-4">
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-wider text-gray-400">Bid session</p>
            <div className="mt-0.5 flex items-center gap-2">
              <h2 id="session-title" className="font-mono text-lg font-semibold text-gray-900">
                {sessionId.slice(0, 8)}
              </h2>
              {status && (
                <span className={`inline-flex items-center gap-1.5 rounded-full bg-gray-50 px-2 py-0.5 text-[11px] font-medium ${status.text}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
                  {status.label}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={copyId}
              title="Copy the full session id"
              className="mt-0.5 flex max-w-full items-center gap-1 font-mono text-[10px] text-gray-400 hover:text-gray-700"
            >
              <span className="truncate">{sessionId}</span>
              <span className="shrink-0 font-sans" aria-live="polite">
                {copied ? "Copied" : ""}
              </span>
            </button>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {position && (
              <span className="mr-1 text-[11px] tabular-nums text-gray-400">
                {position.index + 1} of {position.count}
              </span>
            )}
            <IconButton label="Previous session (K)" disabled={!canPrev} onClick={() => onStep(-1)}>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
            </IconButton>
            <IconButton label="Next session (J)" disabled={!canNext} onClick={() => onStep(1)}>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </IconButton>
            <IconButton label="Close (Esc)" onClick={onClose} buttonRef={closeButton}>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </IconButton>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-4">
          {view && "error" in view ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3" role="alert">
              <p className="text-xs text-red-700">{view.error}</p>
              <button
                type="button"
                onClick={() => setAttempt((a) => a + 1)}
                className="mt-2 text-xs font-medium text-[#006DAE] hover:underline"
              >
                Try again
              </button>
            </div>
          ) : view ? (
            <Detail detail={view.detail} />
          ) : (
            <DetailSkeleton />
          )}
        </div>
      </div>
    </dialog>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  buttonRef,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  buttonRef?: React.Ref<HTMLButtonElement>;
  children: React.ReactNode;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900 disabled:pointer-events-none disabled:opacity-30"
    >
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
        {children}
      </svg>
    </button>
  );
}

function Detail({ detail }: { detail: BlotterDetail }) {
  const s = detail.session;
  const verdict = s.verdict ? VERDICT[s.verdict] : undefined;
  const clearedPrice = s.cleared_mwh > 0 ? s.cleared_cost_inr / (s.cleared_mwh * 1000) : null;
  const facts: [string, React.ReactNode][] = [
    ["Delivery", deliveryDate(s.target_date)],
    [
      "Market",
      <span key="market" className="flex items-center gap-2">
        <span className={`rounded border px-1.5 py-px text-[10px] font-semibold ${SEGMENT_STYLE[s.segment] ?? ""}`}>
          {s.segment}
        </span>
        <span className="capitalize">{s.strategy}</span>
      </span>,
    ],
    ["Submitted", s.submitted_at ? `${submittedAt(s.submitted_at)} IST` : "-"],
    ["Trader", <span key="trader" className="font-mono text-xs">{s.submitted_by ?? "-"}</span>],
    ["Bid volume", `${mwh(s.volume_mwh)} MWh`],
    ["Avg bid price", `${price(s.avg_price)}/kWh`],
    ["Bid value", formatINR(s.value_inr)],
    [
      "Pre-trade check",
      verdict ? (
        <span className={verdict.text}>
          {verdict.label}
          {s.score !== null && <span className="text-gray-400"> · score {s.score.toFixed(0)}</span>}
        </span>
      ) : (
        "-"
      ),
    ],
    ["Blocks", `${s.block_count}${s.overrides ? ` · ${s.overrides} overridden` : ""}`],
    [
      "Cleared",
      s.fill_pct === null ? (
        "Awaiting prices"
      ) : (
        <span>
          {percent(s.fill_pct)}
          <span className="text-gray-400">
            {" "}
            · {s.cleared_blocks} of {s.priced_blocks} priced
          </span>
        </span>
      ),
    ],
    ["Cleared volume", s.fill_pct === null ? "-" : `${mwh(s.cleared_mwh)} MWh`],
    ["Avg cleared price", clearedPrice === null ? "-" : `${price(clearedPrice)}/kWh`],
  ];

  return (
    <div className="flex flex-col gap-6">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
        {facts.map(([term, value]) => (
          <div key={term} className="min-w-0">
            <dt className="text-[11px] text-gray-400">{term}</dt>
            <dd className="mt-0.5 truncate text-sm text-gray-900 tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>

      <section>
        <h3 className="mb-2 text-xs font-semibold text-gray-700">Bids by block</h3>
        <BlockChart blocks={detail.blocks} />
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold text-gray-700">Activity</h3>
        <Activity events={detail.events} />
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold text-gray-700">Blocks</h3>
        <BlockTable blocks={detail.blocks} />
      </section>
    </div>
  );
}

const resultColor = (b: BlotterBlock) =>
  b.cleared === null ? RESULT_COLOR.pending : b.cleared ? RESULT_COLOR.cleared : RESULT_COLOR.missed;

function BlockChart({ blocks }: { blocks: BlotterBlock[] }) {
  const priced = blocks.some((b) => b.mcp !== null);
  return (
    <div>
      <div className="h-52">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={blocks} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" vertical={false} />
            <XAxis
              dataKey="block"
              fontSize={9}
              stroke="#E5E7EB"
              tick={{ fill: "#9CA3AF" }}
              tickLine={false}
              tickFormatter={(b) => blockToTime(b)}
              interval={15}
            />
            <YAxis
              yAxisId="price"
              fontSize={9}
              stroke="#E5E7EB"
              tick={{ fill: "#9CA3AF" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => `₹${v}`}
              width={36}
            />
            <YAxis
              yAxisId="volume"
              orientation="right"
              fontSize={9}
              stroke="#E5E7EB"
              tick={{ fill: "#9CA3AF" }}
              tickLine={false}
              axisLine={false}
              width={30}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              labelFormatter={(b) => `Block ${b} · ${blockToTime(Number(b))}`}
              formatter={(value, name) =>
                name === "Volume" ? `${Number(value).toFixed(1)} MW` : `₹${Number(value).toFixed(2)}/kWh`
              }
            />
            <Bar yAxisId="volume" dataKey="volume_mw" name="Volume" radius={[2, 2, 0, 0]} isAnimationActive={false}>
              {blocks.map((b) => (
                <Cell key={b.block} fill={resultColor(b)} fillOpacity={0.45} />
              ))}
            </Bar>
            <Line
              yAxisId="price"
              type="stepAfter"
              dataKey="price"
              name="Bid price"
              stroke="#006DAE"
              strokeWidth={1.75}
              dot={false}
              isAnimationActive={false}
            />
            {priced && (
              <Line
                yAxisId="price"
                type="monotone"
                dataKey="mcp"
                name="MCP"
                stroke="#0F172A"
                strokeWidth={1.25}
                strokeDasharray="4 3"
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[10px] text-gray-400">
        <LegendItem swatch={<span className="h-0.5 w-3 bg-[#006DAE]" />}>Bid price</LegendItem>
        {priced && (
          <LegendItem swatch={<span className="w-3 border-t border-dashed border-slate-900" />}>
            Clearing price (MCP)
          </LegendItem>
        )}
        <LegendItem swatch={<Swatch color={RESULT_COLOR.cleared} />}>Cleared</LegendItem>
        <LegendItem swatch={<Swatch color={RESULT_COLOR.missed} />}>Not cleared</LegendItem>
        <LegendItem swatch={<Swatch color={RESULT_COLOR.pending} />}>Awaiting price</LegendItem>
      </div>
    </div>
  );
}

const Swatch = ({ color }: { color: string }) => (
  <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: color, opacity: 0.7 }} />
);

function LegendItem({ swatch, children }: { swatch: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      {swatch}
      {children}
    </span>
  );
}

function eventSummary(event: BlotterEvent): string {
  const d = event.details ?? {};
  const parts: string[] = [];
  if (typeof d.verdict === "string") parts.push(VERDICT[d.verdict]?.label ?? d.verdict);
  if (typeof d.score === "number") parts.push(`score ${d.score.toFixed(0)}`);
  if (typeof d.bid_count === "number") parts.push(`${d.bid_count} blocks`);
  return parts.join(" · ");
}

function Activity({ events }: { events: BlotterEvent[] }) {
  if (events.length === 0) return <p className="text-xs text-gray-400">No recorded activity.</p>;
  return (
    <ol className="relative ml-1 border-l border-gray-200">
      {events.map((event, i) => (
        <li key={`${event.timestamp}-${event.action}-${i}`} className="relative pb-3 pl-4 last:pb-0">
          <span
            className={`absolute -left-[4.5px] top-1.5 h-2 w-2 rounded-full ring-2 ring-white ${
              event.action === "submit" ? "bg-[#006DAE]" : "bg-gray-300"
            }`}
          />
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-xs font-medium text-gray-900">{ACTION_LABEL[event.action] ?? event.action}</p>
            <p className="shrink-0 text-[11px] tabular-nums text-gray-400">{submittedAt(event.timestamp)}</p>
          </div>
          <p className="text-[11px] text-gray-500">
            {[eventSummary(event), event.user].filter(Boolean).join(" · ")}
          </p>
        </li>
      ))}
    </ol>
  );
}

function BlockTable({ blocks }: { blocks: BlotterBlock[] }) {
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="border-b border-gray-200 text-left text-gray-500">
          <th className="py-2 pr-3 font-medium">Block</th>
          <th className="py-2 pr-3 font-medium text-right">Bid ₹/kWh</th>
          <th className="py-2 pr-3 font-medium text-right">MW</th>
          <th className="py-2 pr-3 font-medium text-right">MCP</th>
          <th className="py-2 font-medium">Result</th>
        </tr>
      </thead>
      <tbody>
        {blocks.map((b) => (
          <tr key={b.block} className="border-b border-gray-50 last:border-0">
            <td className="py-1.5 pr-3 tabular-nums text-gray-600">
              <span className="inline-block w-6 text-gray-400">{b.block}</span>
              {blockToTime(b.block)}
              {b.is_overridden && (
                <span
                  title={b.override_reason ?? "Overridden"}
                  className="ml-2 rounded border border-amber-200 bg-amber-50 px-1 text-[10px] font-medium text-amber-700"
                >
                  Override
                </span>
              )}
            </td>
            <td className="py-1.5 pr-3 text-right tabular-nums text-gray-900">{b.price.toFixed(2)}</td>
            <td className="py-1.5 pr-3 text-right tabular-nums text-gray-900">{b.volume_mw.toFixed(1)}</td>
            <td className="py-1.5 pr-3 text-right tabular-nums text-gray-600">
              {b.mcp === null ? "-" : b.mcp.toFixed(2)}
            </td>
            <td className="py-1.5">
              <span className="inline-flex items-center gap-1.5 text-gray-600">
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: resultColor(b) }} />
                {b.cleared === null ? "Awaiting price" : b.cleared ? "Cleared" : "Not cleared"}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading the session">
      <div className="grid grid-cols-3 gap-x-6 gap-y-4">
        {Array.from({ length: 9 }, (_, i) => (
          <div key={i}>
            <div className="h-2.5 w-14 rounded bg-gray-100 animate-pulse" />
            <div className="mt-1.5 h-4 w-24 rounded bg-gray-100 animate-pulse" />
          </div>
        ))}
      </div>
      <div className="h-52 rounded-lg bg-gray-50 animate-pulse" />
    </div>
  );
}
