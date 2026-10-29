"use client";

import { useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import {
  assessRisk,
  errorMessage,
  recommendBids,
  type RiskResult,
} from "@/lib/api";
import {
  SEGMENTS,
  STRATEGIES,
  getTomorrowDate,
  formatINR,
} from "@/lib/utils";
import Spinner from "@/components/Spinner";
import PageHeader from "@/components/PageHeader";

const DEFAULT_THRESHOLD = 500000;

export default function RiskPage() {
  const [segment, setSegment] = useState<string>("DAM");
  const [strategy, setStrategy] = useState<string>("balanced");
  const [targetDate, setTargetDate] = useState(getTomorrowDate());
  const [demandMw, setDemandMw] = useState(500);
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [risk, setRisk] = useState<RiskResult | null>(null);
  const [blockCount, setBlockCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleAssess = async () => {
    setLoading(true);
    setError("");
    try {
      // Price the optimizer's recommended schedule, then measure its exposure.
      const recs = await recommendBids(targetDate, strategy, segment, demandMw);
      const bids = recs.map((r) => ({
        block: r.block,
        segment: r.segment,
        price: r.price,
        volume_mw: r.volume_mw,
      }));
      setBlockCount(bids.length);
      setRisk(
        await assessRisk(
          `risk-${Date.now()}`,
          targetDate,
          segment,
          bids,
          threshold,
        ),
      );
    } catch (e) {
      setRisk(null);
      setError(
        errorMessage(
          e,
          "Risk assessment failed. Generate a forecast for this date first.",
        ),
      );
    }
    setLoading(false);
  };

  const exposurePct = risk ? (risk.total_exposure / risk.var_threshold) * 100 : 0;

  const riskMetrics = risk
    ? [
        { name: "VaR (95%)", value: risk.var_95, color: "#006DAE" },
        {
          name: "Expected DSM",
          value: risk.expected_dsm_penalty,
          color: "#f59e0b",
        },
        {
          name: "Worst-case DSM",
          value: risk.worst_case_penalty,
          color: "#ef4444",
        },
        {
          name: "Total exposure",
          value: risk.total_exposure,
          color: risk.alert_triggered ? "#ef4444" : "#00B398",
        },
      ]
    : [];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Risk Assessment"
        description="Value-at-Risk and DSM penalty exposure of the optimized schedule against your alert limit"
      />

      {/* Controls */}
      <div className="card">
        <div className="flex items-end gap-4 flex-wrap">
          <div>
            <label htmlFor="risk-date" className="block text-xs text-gray-500 mb-1">
              Delivery Date
            </label>
            <input
              id="risk-date"
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              className="input-field h-9"
            />
          </div>
          <div>
            <label htmlFor="risk-segment" className="block text-xs text-gray-500 mb-1">
              Segment
            </label>
            <select
              id="risk-segment"
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
          <div>
            <span className="block text-xs text-gray-500 mb-1">Strategy</span>
            <div className="flex h-9 rounded-lg overflow-hidden border border-[var(--border)]">
              {STRATEGIES.map((s) => (
                <button
                  key={s}
                  onClick={() => setStrategy(s)}
                  aria-pressed={strategy === s}
                  className={`px-3 text-sm capitalize transition-colors ${
                    strategy === s
                      ? "bg-[#006DAE] text-white"
                      : "bg-white text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label htmlFor="risk-demand" className="block text-xs text-gray-500 mb-1">
              Demand (MW)
            </label>
            <input
              id="risk-demand"
              type="number"
              min={0}
              value={demandMw}
              onChange={(e) => setDemandMw(Number(e.target.value))}
              className="input-field h-9 w-28"
            />
          </div>
          <div>
            <label htmlFor="risk-threshold" className="block text-xs text-gray-500 mb-1">
              Alert Limit (₹)
            </label>
            <input
              id="risk-threshold"
              type="number"
              min={0}
              step={10000}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              className="input-field h-9 w-32"
            />
          </div>
          <button
            onClick={handleAssess}
            disabled={loading}
            className="btn-primary h-9 !py-0 flex items-center gap-2 disabled:opacity-60"
          >
            {loading && <Spinner />}
            {loading ? "Assessing…" : "Assess Risk"}
          </button>
        </div>
      </div>

      {error && (
        <div className="card py-2 bg-red-50 border-red-200 text-red-600 text-xs" role="alert">
          {error}
        </div>
      )}

      {risk?.alert_triggered && (
        <div className="card bg-red-50 border-red-300" role="alert">
          <p className="text-red-700 font-semibold text-sm">⚠ Risk alert</p>
          <p className="text-red-600 text-xs mt-0.5">
            {risk.alert_details?.message ?? "Exposure exceeds the alert limit."}
          </p>
        </div>
      )}

      {risk && (
        <>
          {/* Metric cards */}
          <div className="grid grid-cols-4 gap-4">
            <MetricCard
              label="VaR (95%)"
              value={formatINR(risk.var_95)}
              sub="Cost overrun at 95% confidence"
              color="text-[#006DAE]"
            />
            <MetricCard
              label="Expected DSM"
              value={formatINR(risk.expected_dsm_penalty)}
              sub="Under the forecast deviation"
              color="text-amber-600"
            />
            <MetricCard
              label="Worst-case DSM"
              value={formatINR(risk.worst_case_penalty)}
              sub="Stress deviation scenario"
              color="text-red-600"
            />
            <MetricCard
              label="Total exposure"
              value={formatINR(risk.total_exposure)}
              sub={`Limit ${formatINR(risk.var_threshold)}`}
              color={risk.alert_triggered ? "text-red-600" : "text-[#00B398]"}
              highlight={risk.alert_triggered}
            />
          </div>

          {risk.forecast_coverage < blockCount && (
            <p className="text-xs text-amber-700">
              Forecast covers {risk.forecast_coverage} of {blockCount} blocks. Exposure
              for uncovered blocks is not included.
            </p>
          )}

          {/* Breakdown chart */}
          <div className="card">
            <h2 className="text-sm font-semibold mb-4 text-gray-700">
              Risk Breakdown
            </h2>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={riskMetrics} layout="vertical" margin={{ left: 8, right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" horizontal={false} />
                <XAxis
                  type="number"
                  stroke="#9CA3AF"
                  fontSize={11}
                  tickFormatter={(v) => formatINR(v)}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  stroke="#9CA3AF"
                  fontSize={11}
                  width={120}
                />
                <Tooltip
                  cursor={{ fill: "#F1F5F9" }}
                  contentStyle={{
                    background: "#FFFFFF",
                    border: "1px solid #E2E8F0",
                    borderRadius: "8px",
                    fontSize: "12px",
                    color: "#1E293B",
                  }}
                  formatter={(val) => formatINR(Number(val))}
                />
                <Bar dataKey="value" radius={[0, 4, 4, 0]} barSize={28}>
                  {riskMetrics.map((entry) => (
                    <Cell key={entry.name} fill={entry.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Limit gauge */}
          <div className="card">
            <div className="flex justify-between items-baseline mb-2">
              <h2 className="text-sm font-semibold text-gray-700">
                Exposure vs Limit
              </h2>
              <span
                className={`text-sm font-semibold tabular-nums ${
                  risk.alert_triggered ? "text-red-600" : "text-teal-600"
                }`}
              >
                {exposurePct.toFixed(0)}%
              </span>
            </div>
            <div className="h-3 bg-gray-200 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  risk.alert_triggered ? "bg-red-500" : "bg-[#00B398]"
                }`}
                style={{ width: `${Math.min(exposurePct, 100)}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-gray-500 mt-2 tabular-nums">
              <span>₹0</span>
              <span>
                {formatINR(risk.total_exposure)} of {formatINR(risk.var_threshold)}
              </span>
            </div>
          </div>
        </>
      )}

      {!risk && !error && (
        <div className="card py-16 text-center">
          <p className="text-sm font-medium text-gray-600">No assessment yet</p>
          <p className="text-xs text-gray-400 mt-1">
            Pick a delivery date with a forecast and click Assess Risk.
          </p>
        </div>
      )}
    </div>
  );
}

function MetricCard({
  label,
  value,
  sub,
  color,
  highlight = false,
}: {
  label: string;
  value: string;
  sub: string;
  color: string;
  highlight?: boolean;
}) {
  return (
    <div className={`card text-center ${highlight ? "border-red-300 bg-red-50" : ""}`}>
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-2xl font-bold tabular-nums ${color}`}>{value}</div>
      <div className="text-[11px] text-gray-400 mt-0.5">{sub}</div>
    </div>
  );
}
