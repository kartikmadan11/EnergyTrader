"use client";

import { useCallback, useEffect, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  BarChart,
  Bar,
  Cell,
} from "recharts";
import {
  postMarketAnalysis,
  getAuditLog,
  errorMessage,
  type AuditEntry,
  type PostMarketSummary,
} from "@/lib/api";
import {
  SEGMENTS,
  formatINR,
  blockToTime,
  getYesterdayDate,
  mapeGrade,
} from "@/lib/utils";
import Spinner from "@/components/Spinner";
import PageHeader from "@/components/PageHeader";

const AUDIT_LIMIT = 50;

const TOOLTIP_STYLE = {
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "8px",
  fontSize: "12px",
  color: "#1e293b",
  boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
};

const ACTION_STYLE: Record<string, string> = {
  submit: "bg-teal-50 text-teal-700 border-teal-200",
  pre_trade_check: "bg-blue-50 text-[#006DAE] border-blue-200",
  policy_activate: "bg-violet-50 text-violet-700 border-violet-200",
  policy_update: "bg-violet-50 text-violet-700 border-violet-200",
};

const IST_TIMESTAMP = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  dateStyle: "medium",
  timeStyle: "short",
});

type Tone = "warn" | "good" | "info";

function observations(r: PostMarketSummary): { tone: Tone; text: string }[] {
  const out: { tone: Tone; text: string }[] = [];
  const hasBids = r.session_id !== null;

  if (r.mape !== null) {
    if (r.mape > 10)
      out.push({
        tone: "warn",
        text: `Forecast MAPE is ${r.mape.toFixed(1)}%. Retrain on recent data or enable the weather and holiday features.`,
      });
    else if (r.mape > 5)
      out.push({
        tone: "info",
        text: `Forecast MAPE of ${r.mape.toFixed(1)}% is acceptable. Weather features may tighten it further.`,
      });
    else
      out.push({
        tone: "good",
        text: `Forecast MAPE of ${r.mape.toFixed(1)}% is within the 5% target.`,
      });
  }

  if (!hasBids) {
    out.push({
      tone: "info",
      text: "No bids were submitted for this date, so clearing metrics are unavailable. Submit from the Workstation to track them.",
    });
    return out;
  }

  if (r.bid_hit_rate < 50)
    out.push({
      tone: "warn",
      text: `Only ${r.bid_hit_rate.toFixed(0)}% of bid blocks cleared. Bid prices sat below the clearing price in most blocks; a less conservative strategy or a positive price offset would clear more volume.`,
    });
  else if (r.bid_hit_rate > 90)
    out.push({
      tone: "info",
      text: `${r.bid_hit_rate.toFixed(0)}% of bid blocks cleared. Bid prices may be higher than needed, so there is room to shade them down.`,
    });

  if (r.basket_rate_change_pct < -2)
    out.push({
      tone: "good",
      text: `Cleared volume was bought ${Math.abs(r.basket_rate_change_pct).toFixed(1)}% below the volume-weighted MCP across all bid blocks.`,
    });
  else if (r.basket_rate_change_pct > 2)
    out.push({
      tone: "warn",
      text: `Cleared volume cost ${r.basket_rate_change_pct.toFixed(1)}% more than the volume-weighted MCP across all bid blocks. Expensive blocks cleared while cheaper ones did not.`,
    });

  if (r.uncleared_dsm_exposure > 50000)
    out.push({
      tone: "warn",
      text: `Uncleared volume carries ${formatINR(r.uncleared_dsm_exposure)} of DSM exposure if drawn from the grid. Raise the DSM weight (λ₁) or bid closer to the forecast upper bound.`,
    });
  else if (r.uncleared_dsm_exposure === 0)
    out.push({
      tone: "good",
      text: "Every bid block cleared, so there is no DSM exposure from unmet volume.",
    });

  return out;
}

function summarizeDetails(details: AuditEntry["details"]): string {
  if (!details) return "-";
  return Object.entries(details)
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" · ");
}

export default function AnalysisPage() {
  const [segment, setSegment] = useState<string>("DAM");
  const [targetDate, setTargetDate] = useState(getYesterdayDate());
  const [result, setResult] = useState<PostMarketSummary | null>(null);
  const [auditLog, setAuditLog] = useState<AuditEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const loadAudit = useCallback(async () => {
    try {
      setAuditLog(await getAuditLog(undefined, AUDIT_LIMIT));
    } catch {
      setAuditLog([]);
    }
  }, []);

  useEffect(() => {
    loadAudit();
  }, [loadAudit]);

  const handleAnalyze = async () => {
    setLoading(true);
    setError("");
    try {
      setResult(await postMarketAnalysis(targetDate, segment));
    } catch (e) {
      setResult(null);
      setError(
        errorMessage(e, "Analysis failed. Check that actual prices exist for this date."),
      );
    }
    await loadAudit();
    setLoading(false);
  };

  const hasBids = result?.session_id != null;
  const comparison =
    result?.blocks.map((b) => ({
      block: b.block,
      predicted: b.predicted_price,
      actual: b.actual_price,
      bid: b.bid_price,
    })) ?? [];
  const errorDistribution =
    result?.blocks.flatMap((b) =>
      b.error_pct !== null ? [{ block: b.block, error_pct: b.error_pct }] : [],
    ) ?? [];
  const notes = result ? observations(result) : [];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Post-Market Analysis"
        description="Compare forecasts and submitted bids with cleared prices for a past delivery date"
      />

      {/* Controls */}
      <div className="card">
        <div className="flex items-end gap-4 flex-wrap">
          <div>
            <label htmlFor="pm-date" className="block text-xs text-gray-500 mb-1">
              Delivery Date
            </label>
            <input
              id="pm-date"
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              className="input-field h-9"
            />
          </div>
          <div>
            <label htmlFor="pm-segment" className="block text-xs text-gray-500 mb-1">
              Segment
            </label>
            <select
              id="pm-segment"
              value={segment}
              onChange={(e) => setSegment(e.target.value)}
              className="select-field h-9"
            >
              {SEGMENTS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={handleAnalyze}
            disabled={loading}
            className="btn-primary h-9 !py-0 flex items-center gap-2 disabled:opacity-60"
          >
            {loading && <Spinner />}
            {loading ? "Analyzing…" : "Run Analysis"}
          </button>
        </div>
      </div>

      {error && (
        <div className="card py-2 bg-red-50 border-red-200 text-red-600 text-xs" role="alert">
          {error}
        </div>
      )}

      {result && (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-5 gap-4">
            <Kpi
              label="Forecast MAPE"
              value={result.mape !== null ? `${result.mape.toFixed(1)}%` : "n/a"}
              sub={result.mape !== null ? mapeGrade(result.mape).label : "No forecast above the price floor"}
              color={result.mape !== null ? mapeGrade(result.mape).color : "text-gray-400"}
            />
            <Kpi
              label="Forecast MAE"
              value={result.mae !== null ? `₹${result.mae.toFixed(2)}` : "n/a"}
              sub="Per kWh, across forecast blocks"
              color="text-gray-800"
            />
            <Kpi
              label="Bid Hit Rate"
              value={hasBids ? `${result.bid_hit_rate.toFixed(0)}%` : "n/a"}
              sub={hasBids ? "Bid blocks that cleared" : "No submitted bids"}
              color={hasBids ? "text-[#006DAE]" : "text-gray-400"}
            />
            <Kpi
              label="Basket vs Baseline"
              value={
                hasBids
                  ? `${result.basket_rate_change_pct > 0 ? "+" : ""}${result.basket_rate_change_pct.toFixed(1)}%`
                  : "n/a"
              }
              sub={
                hasBids
                  ? `₹${result.basket_rate.toFixed(2)} vs ₹${result.baseline_basket_rate.toFixed(2)}`
                  : "No submitted bids"
              }
              color={
                !hasBids
                  ? "text-gray-400"
                  : result.basket_rate_change_pct <= 0
                    ? "text-teal-600"
                    : "text-red-600"
              }
            />
            <Kpi
              label="Uncleared DSM Exposure"
              value={hasBids ? formatINR(result.uncleared_dsm_exposure) : "n/a"}
              sub={hasBids ? "If unmet volume is drawn from the grid" : "No submitted bids"}
              color={
                !hasBids
                  ? "text-gray-400"
                  : result.uncleared_dsm_exposure > 0
                    ? "text-amber-600"
                    : "text-teal-600"
              }
            />
          </div>

          {/* Forecast and bids vs actual */}
          <div className="card">
            <div className="flex items-baseline justify-between mb-4">
              <h2 className="text-sm font-semibold text-gray-700">
                Forecast vs Actual · {result.segment} · {result.target_date}
              </h2>
              {hasBids && (
                <span className="font-mono text-[10px] text-gray-400">
                  session {result.session_id}
                </span>
              )}
            </div>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={comparison}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis
                  dataKey="block"
                  stroke="#94a3b8"
                  fontSize={10}
                  tickFormatter={(b) => blockToTime(b)}
                  interval={7}
                />
                <YAxis
                  stroke="#94a3b8"
                  fontSize={11}
                  tickFormatter={(v) => `₹${v.toFixed(1)}`}
                />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(val: number) => `₹${val.toFixed(3)}/kWh`}
                  labelFormatter={(b) => `Block ${b} (${blockToTime(Number(b))})`}
                />
                <Legend wrapperStyle={{ fontSize: "12px" }} />
                <Line
                  type="monotone"
                  dataKey="actual"
                  stroke="#00B398"
                  strokeWidth={2}
                  dot={false}
                  name="Actual MCP"
                />
                <Line
                  type="monotone"
                  dataKey="predicted"
                  stroke="#006DAE"
                  strokeWidth={2}
                  dot={false}
                  name="Forecast"
                  connectNulls
                />
                {hasBids && (
                  <Line
                    type="stepAfter"
                    dataKey="bid"
                    stroke="#f59e0b"
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                    dot={false}
                    name="Bid price"
                    connectNulls
                  />
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Error distribution */}
          {errorDistribution.length > 0 && (
            <div className="card">
              <h2 className="text-sm font-semibold mb-4 text-gray-700">
                Absolute Forecast Error by Block
              </h2>
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={errorDistribution}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis
                    dataKey="block"
                    stroke="#94a3b8"
                    fontSize={10}
                    tickFormatter={(b) => blockToTime(b)}
                    interval={7}
                  />
                  <YAxis
                    stroke="#94a3b8"
                    fontSize={11}
                    tickFormatter={(v) => `${v.toFixed(0)}%`}
                  />
                  <Tooltip
                    cursor={{ fill: "#F1F5F9" }}
                    contentStyle={TOOLTIP_STYLE}
                    formatter={(v: number) => `${v.toFixed(2)}%`}
                    labelFormatter={(b) => `Block ${b} (${blockToTime(Number(b))})`}
                  />
                  <Bar dataKey="error_pct" name="Error" radius={[2, 2, 0, 0]}>
                    {errorDistribution.map((entry) => (
                      <Cell
                        key={entry.block}
                        fill={entry.error_pct > 10 ? "#ef4444" : "#006DAE"}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <p className="text-[11px] text-gray-400 mt-2">
                Red bars exceed 10%. Blocks priced below ₹1/kWh are excluded.
              </p>
            </div>
          )}

          {/* Observations */}
          {notes.length > 0 && (
            <div className="card">
              <h2 className="text-sm font-semibold mb-4 text-gray-700">
                Observations
              </h2>
              <ul className="space-y-2">
                {notes.map((n) => (
                  <li
                    key={n.text}
                    className={`flex items-start gap-3 p-3 rounded-lg border text-sm ${
                      n.tone === "warn"
                        ? "bg-amber-50 border-amber-200 text-amber-900"
                        : n.tone === "good"
                          ? "bg-teal-50 border-teal-200 text-teal-900"
                          : "bg-blue-50 border-blue-200 text-blue-900"
                    }`}
                  >
                    <span aria-hidden className="mt-px">
                      {n.tone === "warn" ? "⚠" : n.tone === "good" ? "✓" : "ℹ"}
                    </span>
                    {n.text}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {/* Audit trail */}
      <div className="card">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-sm font-semibold text-gray-700">Audit Trail</h2>
          <span className="text-[11px] text-gray-400">
            Latest {AUDIT_LIMIT} entries · IST
          </span>
        </div>
        {auditLog === null ? (
          <p className="text-gray-400 text-sm">Loading…</p>
        ) : auditLog.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-200 text-gray-500 text-left">
                  <th className="py-2 pr-3 font-medium">Time</th>
                  <th className="py-2 pr-3 font-medium">Action</th>
                  <th className="py-2 pr-3 font-medium">Session</th>
                  <th className="py-2 pr-3 font-medium">User</th>
                  <th className="py-2 font-medium">Details</th>
                </tr>
              </thead>
              <tbody>
                {auditLog.map((log) => {
                  const details = summarizeDetails(log.details);
                  return (
                    <tr key={log.id} className="border-b border-gray-100 last:border-0">
                      <td className="py-2 pr-3 text-gray-500 whitespace-nowrap tabular-nums">
                        {log.timestamp ? IST_TIMESTAMP.format(new Date(log.timestamp)) : "-"}
                      </td>
                      <td className="py-2 pr-3">
                        <span
                          className={`px-2 py-0.5 rounded border text-[11px] font-medium ${
                            ACTION_STYLE[log.action] ?? "bg-gray-50 text-gray-600 border-gray-200"
                          }`}
                        >
                          {log.action.replace(/_/g, " ")}
                        </span>
                      </td>
                      <td className="py-2 pr-3 font-mono text-[11px] text-gray-500 whitespace-nowrap">
                        {log.session_id ?? "-"}
                      </td>
                      <td className="py-2 pr-3 text-gray-600">{log.user ?? "-"}</td>
                      <td className="py-2 text-gray-500 truncate max-w-[360px]" title={details}>
                        {details}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-gray-400 text-sm">
            No audit entries yet. Pre-trade checks, submissions and policy
            changes are recorded here.
          </p>
        )}
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub: string;
  color: string;
}) {
  return (
    <div className="card text-center">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-2xl font-bold tabular-nums ${color}`}>{value}</div>
      <div className="text-[11px] text-gray-400 mt-0.5">{sub}</div>
    </div>
  );
}
