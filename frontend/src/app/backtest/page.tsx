"use client";

import { useState } from "react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ReferenceLine,
} from "recharts";
import {
  evaluateForecast,
  errorMessage,
  type BacktestBlock,
  type BacktestDay,
  type BacktestResult,
} from "@/lib/api";
import { SEGMENTS, blockToTime, mapeGrade, marketDate } from "@/lib/utils";
import Spinner from "@/components/Spinner";
import PageHeader from "@/components/PageHeader";

const TOOLTIP_STYLE = {
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "8px",
  fontSize: "12px",
  color: "#1e293b",
  boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
};

const SPLIT_COLOR: Record<BacktestDay["data_split"], string> = {
  train: "#f59e0b",
  test: "#006DAE",
  unseen: "#00B398",
};

const SPLIT_LABEL: Record<BacktestDay["data_split"], string> = {
  train: "train",
  test: "held-out test",
  unseen: "unseen",
};

// Absolute forecast error buckets for the distribution view.
const ERROR_BANDS = { tight: 10, wide: 20 };

/** MAPE where defined, otherwise sMAPE for days priced entirely below the floor. */
function dayError(d: { mape: number | null; smape: number }) {
  return d.mape !== null
    ? { value: d.mape, metric: "MAPE" }
    : { value: d.smape, metric: "sMAPE" };
}

function KpiCard({
  label,
  value,
  sub,
  colorClass,
  tooltip,
}: {
  label: string;
  value: string;
  sub?: string;
  colorClass?: string;
  tooltip?: string;
}) {
  return (
    <div className="card">
      <p className="text-xs text-gray-500 mb-1 flex items-center gap-1">
        {label}
        {tooltip && (
          <span className="group relative inline-flex items-center">
            <span className="flex items-center justify-center w-3.5 h-3.5 rounded-full border border-gray-300 text-[9px] font-bold text-gray-400 cursor-help hover:border-gray-500 hover:text-gray-600 leading-none">
              ?
            </span>
            <span
              role="tooltip"
              className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 rounded-md bg-gray-800 px-2.5 py-2 text-[11px] font-normal text-white shadow-lg opacity-0 group-hover:opacity-100 transition-opacity z-50 leading-relaxed"
            >
              {tooltip}
            </span>
          </span>
        )}
      </p>
      <p className={`text-2xl font-bold tabular-nums ${colorClass ?? "text-gray-900"}`}>
        {value}
      </p>
      {sub && <p className="text-[11px] text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}

function BlockTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload: BacktestBlock }[];
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div style={TOOLTIP_STYLE} className="p-2 space-y-0.5">
      <p className="text-gray-700 font-medium">
        Block {d.block} ({blockToTime(d.block)})
      </p>
      <p className="text-[#006DAE]">Forecast ₹{d.predicted.toFixed(3)}</p>
      <p className="text-teal-600">Actual ₹{d.actual.toFixed(3)}</p>
      <p className={d.error_pct !== null && d.error_pct > ERROR_BANDS.tight ? "text-red-600" : "text-gray-500"}>
        Error {d.error_pct !== null ? `${d.error_pct.toFixed(2)}%` : "n/a (below ₹1 floor)"}
      </p>
    </div>
  );
}

export default function BacktestPage() {
  const [segment, setSegment] = useState("DAM");
  const [startDate, setStartDate] = useState(marketDate(-14));
  const [endDate, setEndDate] = useState(marketDate(-1));
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [selectedDate, setSelectedDate] = useState("");
  const [error, setError] = useState("");

  const handleRun = async () => {
    setLoading(true);
    setError("");
    setResult(null);
    setSelectedDate("");
    try {
      const data = await evaluateForecast(startDate, endDate, segment);
      setResult(data);
      if (data.daily.length) setSelectedDate(data.daily[0].date);
    } catch (e) {
      setError(
        errorMessage(
          e,
          "Backtest failed. Check that a model is trained and actuals exist for the date range.",
        ),
      );
    } finally {
      setLoading(false);
    }
  };

  const selectedDay = result?.daily.find((d) => d.date === selectedDate);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Backtest"
        description="Walk-forward evaluation: each date is forecast from the history before it, then scored against cleared prices"
      />

      {/* Controls */}
      <div className="card">
        <div className="flex items-end gap-4 flex-wrap">
          <div>
            <label htmlFor="bt-segment" className="block text-xs text-gray-500 mb-1">
              Segment
            </label>
            <select
              id="bt-segment"
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
            <label htmlFor="bt-start" className="block text-xs text-gray-500 mb-1">
              Start Date
            </label>
            <input
              id="bt-start"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="input-field h-9"
            />
          </div>
          <div>
            <label htmlFor="bt-end" className="block text-xs text-gray-500 mb-1">
              End Date
            </label>
            <input
              id="bt-end"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="input-field h-9"
            />
          </div>
          <button
            onClick={handleRun}
            disabled={loading}
            className="btn-primary h-9 !py-0 flex items-center gap-2 disabled:opacity-60"
          >
            {loading && <Spinner />}
            {loading ? "Running…" : "Run Backtest"}
          </button>
          {result && !loading && (
            <span className="h-9 flex items-center text-xs text-gray-500">
              {result.days_evaluated} day{result.days_evaluated !== 1 ? "s" : ""} evaluated
            </span>
          )}
        </div>
        <p className="text-[11px] text-gray-400 mt-2">
          Up to 30 days. Dates without actuals or with under a week of prior
          history are skipped.
        </p>
      </div>

      {error && (
        <div className="card py-2 bg-red-50 border-red-200 text-red-600 text-xs" role="alert">
          {error}
        </div>
      )}

      {result && <SplitBanner daily={result.daily} />}

      {result && (
        <>
          {/* Aggregate KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {(() => {
              const agg = dayError(result.aggregate);
              const grade = mapeGrade(agg.value);
              return (
                <KpiCard
                  label={`Overall ${agg.metric}`}
                  value={`${agg.value.toFixed(2)}%`}
                  sub={grade.label}
                  colorClass={grade.color}
                  tooltip="Mean absolute percentage error over blocks priced at or above ₹1/kWh. Falls back to sMAPE when no block qualifies."
                />
              );
            })()}
            <KpiCard
              label="MAE (₹/kWh)"
              value={`₹${result.aggregate.mae.toFixed(3)}`}
              sub="Mean absolute error"
              tooltip="Average absolute gap between the forecast and the cleared price."
            />
            <KpiCard
              label="RMSE (₹/kWh)"
              value={`₹${result.aggregate.rmse.toFixed(3)}`}
              sub="Root mean squared error"
              tooltip="Like MAE, but penalizes large misses more heavily. A wide gap to MAE points to a few badly missed blocks."
            />
            <KpiCard
              label="R²"
              value={result.aggregate.r2.toFixed(3)}
              sub="Variance explained"
              colorClass={
                result.aggregate.r2 >= 0.9
                  ? "text-teal-600"
                  : result.aggregate.r2 >= 0.7
                    ? "text-[#006DAE]"
                    : "text-amber-600"
              }
              tooltip="Share of block-to-block price variance the forecast explains. 1.0 is a perfect fit; 0 is no better than the mean."
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            {(
              [
                ["Best Day", result.best_day, "text-teal-600"],
                ["Worst Day", result.worst_day, "text-red-600"],
              ] as const
            ).map(([label, day, color]) => {
              const e = dayError(day);
              return (
                <button
                  key={label}
                  onClick={() => setSelectedDate(day.date)}
                  className="card text-left hover:border-[#006DAE] transition-colors"
                >
                  <p className="text-xs text-gray-500 mb-1">{label}</p>
                  <p className={`text-lg font-bold tabular-nums ${color}`}>{day.date}</p>
                  <p className="text-xs text-gray-500 tabular-nums">
                    {e.metric} {e.value.toFixed(2)}%
                  </p>
                </button>
              );
            })}
          </div>

          {/* Daily error */}
          <div className="card">
            <h2 className="text-sm font-semibold mb-4 text-gray-700">Daily Error (%)</h2>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart
                data={result.daily.map((d) => ({ ...d, error: dayError(d).value }))}
                margin={{ top: 4, right: 8, left: -10, bottom: 0 }}
                onClick={(e) => {
                  const date = e?.activePayload?.[0]?.payload?.date;
                  if (date) setSelectedDate(date);
                }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis
                  dataKey="date"
                  stroke="#94a3b8"
                  fontSize={10}
                  tickFormatter={(v: string) => v.slice(5)}
                />
                <YAxis stroke="#94a3b8" fontSize={11} unit="%" />
                <Tooltip
                  cursor={{ fill: "#F1F5F9" }}
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(v: number, _n, item) => [
                    `${v.toFixed(2)}%`,
                    `${dayError(item.payload).metric} (${SPLIT_LABEL[item.payload.data_split as BacktestDay["data_split"]]})`,
                  ]}
                />
                {result.aggregate.mape !== null && (
                  <ReferenceLine
                    y={result.aggregate.mape}
                    stroke="#64748b"
                    strokeDasharray="4 4"
                    label={{ value: "overall", fill: "#64748b", fontSize: 10, position: "insideTopRight" }}
                  />
                )}
                <Bar dataKey="error" radius={[3, 3, 0, 0]} cursor="pointer" isAnimationActive={false}>
                  {result.daily.map((d) => (
                    <Cell
                      key={d.date}
                      fill={SPLIT_COLOR[d.data_split]}
                      fillOpacity={d.date === selectedDate ? 1 : 0.75}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <p className="text-[11px] text-gray-400 mt-2">
              Bars are colored by data split. Click a bar to see that day block by block.
            </p>
          </div>

          {/* Daily average */}
          <div className="card">
            <h2 className="text-sm font-semibold mb-4 text-gray-700">
              Daily Average Price · Forecast vs Actual
            </h2>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={result.daily} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis
                  dataKey="date"
                  stroke="#94a3b8"
                  fontSize={10}
                  tickFormatter={(v: string) => v.slice(5)}
                />
                <YAxis
                  stroke="#94a3b8"
                  fontSize={11}
                  tickFormatter={(v: number) => `₹${v.toFixed(1)}`}
                />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(v: number) => `₹${v.toFixed(3)}/kWh`}
                />
                <Legend wrapperStyle={{ fontSize: "12px" }} />
                <Line
                  type="monotone"
                  dataKey="avg_actual"
                  stroke="#00B398"
                  strokeWidth={2}
                  dot={false}
                  name="Actual"
                />
                <Line
                  type="monotone"
                  dataKey="avg_predicted"
                  stroke="#006DAE"
                  strokeWidth={2}
                  dot={false}
                  name="Forecast"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Block-level drill-down */}
          <div className="card">
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <h2 className="text-sm font-semibold text-gray-700">Block-Level Detail</h2>
                {selectedDay && (
                  <p className="text-xs text-gray-500 mt-0.5 tabular-nums">
                    {dayError(selectedDay).metric} {dayError(selectedDay).value.toFixed(2)}% · MAE ₹
                    {selectedDay.mae.toFixed(3)} · average forecast ₹
                    {selectedDay.avg_predicted.toFixed(2)} vs actual ₹
                    {selectedDay.avg_actual.toFixed(2)}
                  </p>
                )}
              </div>
              <label htmlFor="bt-day" className="sr-only">
                Day
              </label>
              <select
                id="bt-day"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="select-field text-xs"
              >
                {result.daily.map((d) => (
                  <option key={d.date} value={d.date}>
                    {d.date} · {dayError(d).value.toFixed(1)}%
                  </option>
                ))}
              </select>
            </div>
            {selectedDay && (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={selectedDay.blocks} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis
                    dataKey="block"
                    stroke="#94a3b8"
                    fontSize={10}
                    tickFormatter={(b: number) => blockToTime(b)}
                    interval={7}
                  />
                  <YAxis
                    stroke="#94a3b8"
                    fontSize={11}
                    tickFormatter={(v: number) => `₹${v.toFixed(1)}`}
                  />
                  <Tooltip content={<BlockTooltip />} />
                  <Legend wrapperStyle={{ fontSize: "12px" }} />
                  <Line
                    type="monotone"
                    dataKey="actual"
                    stroke="#00B398"
                    strokeWidth={1.5}
                    dot={false}
                    name="Actual"
                  />
                  <Line
                    type="monotone"
                    dataKey="predicted"
                    stroke="#006DAE"
                    strokeWidth={1.5}
                    dot={false}
                    name="Forecast"
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>

          <ErrorDistribution result={result} />
        </>
      )}

      {!result && !error && !loading && (
        <div className="card py-16 text-center">
          <p className="text-sm font-medium text-gray-600">No backtest yet</p>
          <p className="text-xs text-gray-400 mt-1">
            Train a model, pick a date range and click Run Backtest.
          </p>
        </div>
      )}
    </div>
  );
}

function SplitBanner({ daily }: { daily: BacktestDay[] }) {
  const count = (s: BacktestDay["data_split"]) =>
    daily.filter((d) => d.data_split === s).length;
  const counts = { train: count("train"), test: count("test"), unseen: count("unseen") };
  const allTrain = counts.train === daily.length;
  const message = allTrain
    ? "⚠ Every evaluated date was in the training set, so this measures fit rather than out-of-sample accuracy."
    : counts.unseen > 0
      ? "✓ Includes dates the model never saw, so results reflect out-of-sample accuracy."
      : "Evaluated dates come from the held-out test split.";

  return (
    <div
      className={`card py-2.5 flex items-center gap-4 flex-wrap ${
        allTrain ? "border-amber-300 bg-amber-50" : ""
      }`}
    >
      <p className={`text-xs font-medium ${allTrain ? "text-amber-700" : "text-gray-600"}`}>
        {message}
      </p>
      <div className="flex items-center gap-3 ml-auto text-[11px] text-gray-500">
        {(Object.keys(counts) as BacktestDay["data_split"][])
          .filter((s) => counts[s] > 0)
          .map((s) => (
            <span key={s} className="flex items-center gap-1.5 tabular-nums">
              <span
                className="w-2.5 h-2.5 rounded-sm inline-block"
                style={{ background: SPLIT_COLOR[s] }}
              />
              {counts[s]}d {SPLIT_LABEL[s]}
            </span>
          ))}
      </div>
    </div>
  );
}

function ErrorDistribution({ result }: { result: BacktestResult }) {
  const bucket = (blocks: BacktestBlock[]) => {
    const scored = blocks.flatMap((b) => (b.error_pct !== null ? [b.error_pct] : []));
    return {
      tight: scored.filter((e) => e < ERROR_BANDS.tight).length,
      moderate: scored.filter((e) => e >= ERROR_BANDS.tight && e < ERROR_BANDS.wide).length,
      wide: scored.filter((e) => e >= ERROR_BANDS.wide).length,
      unscored: blocks.length - scored.length,
      scored: scored.length,
    };
  };

  const all = bucket(result.daily.flatMap((d) => d.blocks));
  if (all.scored === 0) return null;
  const pct = (n: number) => `${((n / all.scored) * 100).toFixed(1)}%`;
  const daily = result.daily.map((d) => ({ date: d.date.slice(5), ...bucket(d.blocks) }));

  const tiles = [
    { label: `Under ${ERROR_BANDS.tight}%`, n: all.tight, tone: "border-teal-200 bg-teal-50 text-teal-700" },
    {
      label: `${ERROR_BANDS.tight} to ${ERROR_BANDS.wide}%`,
      n: all.moderate,
      tone: "border-amber-200 bg-amber-50 text-amber-700",
    },
    { label: `Over ${ERROR_BANDS.wide}%`, n: all.wide, tone: "border-red-200 bg-red-50 text-red-700" },
  ];

  return (
    <div className="card space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-gray-700">Block Error Distribution</h2>
        <p className="text-[11px] text-gray-400 mt-0.5">
          Blocks by absolute forecast error. Blocks priced below ₹1/kWh are not
          scored, which leaves {all.scored} scored blocks.
        </p>
      </div>
      <div className="grid grid-cols-3 gap-4">
        {tiles.map((t) => (
          <div key={t.label} className={`rounded-lg border p-3 ${t.tone}`}>
            <p className="text-xs">{t.label}</p>
            <p className="text-xl font-bold tabular-nums">{pct(t.n)}</p>
            <p className="text-[11px] opacity-80 tabular-nums">{t.n} blocks</p>
          </div>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={daily} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
          <XAxis dataKey="date" stroke="#94a3b8" fontSize={10} />
          <YAxis stroke="#94a3b8" fontSize={11} domain={[0, 96]} ticks={[0, 24, 48, 72, 96]} />
          <Tooltip
            cursor={{ fill: "#F1F5F9" }}
            contentStyle={TOOLTIP_STYLE}
            formatter={(v: number, name: string) => [`${v} blocks`, name]}
          />
          <Legend wrapperStyle={{ fontSize: "12px" }} />
          <Bar dataKey="tight" stackId="a" fill="#00B398" name={tiles[0].label} />
          <Bar dataKey="moderate" stackId="a" fill="#f59e0b" name={tiles[1].label} />
          <Bar dataKey="wide" stackId="a" fill="#ef4444" name={tiles[2].label} />
          <Bar dataKey="unscored" stackId="a" fill="#94a3b8" name="Below ₹1 (not scored)" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
