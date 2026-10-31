"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import PageHeader from "@/components/PageHeader";
import {
  ComposedChart,
  Line,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import {
  getLatestForecast,
  getHistory,
  getHealth,
  triggerScrape,
  errorMessage,
  type DataHealth,
  type SegmentHealth,
} from "@/lib/api";
import { blockToTime, marketDate, shortDate } from "@/lib/utils";
import RangeMeasure, { MEASURE_MARGIN_TOP } from "@/components/RangeMeasure";

const SEGMENTS = ["DAM", "RTM", "TAM"] as const;
type Segment = (typeof SEGMENTS)[number];

// The scraper takes at most 30 days per request, so longer ranges sync in windows.
const SYNC_WINDOW_DAYS = 30;

/** [start, end] windows covering the last `days` days (IST), newest first. */
function syncWindows(days: number): [string, string][] {
  const windows: [string, string][] = [];
  for (let end = 0; end > -days; end -= SYNC_WINDOW_DAYS) {
    const start = Math.max(end - SYNC_WINDOW_DAYS + 1, 1 - days);
    windows.push([marketDate(start), marketDate(end)]);
  }
  return windows;
}

const SEGMENT_META: Record<
  Segment,
  { label: string; color: string; predColor: string; desc: string }
> = {
  DAM: {
    label: "Day-Ahead Market",
    color: "#006DAE",
    predColor: "#00B398",
    desc: "Gate closure D-1 · 96 blocks",
  },
  RTM: {
    label: "Real-Time Market",
    color: "#F59E0B",
    predColor: "#EF4444",
    desc: "Gate closure 55 min · 96 blocks",
  },
  TAM: {
    label: "Term-Ahead Market",
    color: "#8B5CF6",
    predColor: "#EC4899",
    desc: "Intraday · Weekly · Monthly",
  },
};

interface ChartPoint {
  key: string;
  date: string;
  block: number;
  label: string;
  actual?: number;
  predicted?: number;
  band?: [number, number];
}

interface SegmentState {
  points: ChartPoint[];
  avgActual: number;
  avgPred: number | null;
  hasPred: boolean;
  loaded: boolean;
}

interface TooltipEntry {
  name: string;
  color: string;
  value?: number | [number, number] | null;
}

const CustomTooltip = ({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string;
}) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs shadow-lg">
      <p className="text-gray-500 mb-1 font-medium border-b border-gray-100 pb-1">{label}</p>
      {payload.map((p) => {
        if (p.value === undefined || p.value === null) return null;
        return (
          <div key={p.name} className="flex items-center justify-between gap-4 py-0.5">
            <span className="text-gray-500">{p.name}:</span>
            <span style={{ color: p.color }} className="font-bold tabular-nums">
              {Array.isArray(p.value)
                ? `₹${p.value[0].toFixed(3)} to ₹${p.value[1].toFixed(3)}`
                : `₹${p.value.toFixed(3)}/kWh`}
            </span>
          </div>
        );
      })}
    </div>
  );
};

// Asking for the latest forecast of a segment that has none is a 404, so ask only when
// the health summary says one exists.
const hasForecast = (health: DataHealth | null, seg: Segment) =>
  health?.segments[seg]?.latest_forecast != null;

export default function MarketDataSyncPage() {
  const [fetchDays, setFetchDays] = useState<number>(14);
  const [data, setData] = useState<Record<Segment, SegmentState>>({
    DAM: {
      points: [],
      avgActual: 0,
      avgPred: null,
      hasPred: false,
      loaded: false,
    },
    RTM: {
      points: [],
      avgActual: 0,
      avgPred: null,
      hasPred: false,
      loaded: false,
    },
    TAM: {
      points: [],
      avgActual: 0,
      avgPred: null,
      hasPred: false,
      loaded: false,
    },
  });
  const [scraping, setScraping] = useState<Record<Segment, boolean>>({
    DAM: false,
    RTM: false,
    TAM: false,
  });
  const [scrapeInfo, setScrapeInfo] = useState<
    Record<Segment, SegmentHealth | null>
  >({ DAM: null, RTM: null, TAM: null });
  const [scrapeError, setScrapeError] = useState<
    Record<Segment, string | null>
  >({ DAM: null, RTM: null, TAM: null });
  const [progress, setProgress] = useState<Record<Segment, string | null>>({
    DAM: null,
    RTM: null,
    TAM: null,
  });
  const [syncingAll, setSyncingAll] = useState(false);

  const loadSegment = async (seg: Segment, withForecast: boolean) => {
    setData((prev) => ({ ...prev, [seg]: { ...prev[seg], loaded: false } }));
    try {
      const [histRaw, forecastRaw] = await Promise.allSettled([
        getHistory(seg, 7),
        withForecast ? getLatestForecast(seg) : Promise.resolve(null),
      ]);

      const histRows = histRaw.status === "fulfilled" ? histRaw.value : [];
      const forecast =
        forecastRaw.status === "fulfilled" && forecastRaw.value?.blocks.length
          ? forecastRaw.value
          : null;

      // One point per (date, block). A forecast for a date that already has
      // actuals overlays them; a forecast for a future date extends the series.
      const byKey = new Map<string, ChartPoint>();
      const pointFor = (date: string, block: number) => {
        const key = `${date}|${String(block).padStart(2, "0")}`;
        let p = byKey.get(key);
        if (!p) {
          p = { key, date, block, label: `${date.slice(5)} ${blockToTime(block)}` };
          byKey.set(key, p);
        }
        return p;
      };
      for (const row of histRows) {
        pointFor(row.date, row.block).actual = row.mcp;
      }
      if (forecast) {
        for (const fb of forecast.blocks) {
          const p = pointFor(forecast.target_date, fb.block);
          p.predicted = fb.predicted_price;
          p.band = [fb.confidence_low, fb.confidence_high];
        }
      }
      const points = Array.from(byKey.values()).sort((a, b) =>
        a.key.localeCompare(b.key),
      );

      const actualVals = points.flatMap((p) =>
        p.actual !== undefined ? [p.actual] : [],
      );
      const predVals = points.flatMap((p) =>
        p.predicted !== undefined ? [p.predicted] : [],
      );

      setData((prev) => ({
        ...prev,
        [seg]: {
          points,
          avgActual: actualVals.length
            ? actualVals.reduce((s, v) => s + v, 0) / actualVals.length
            : 0,
          avgPred: predVals.length
            ? predVals.reduce((s, v) => s + v, 0) / predVals.length
            : null,
          hasPred: predVals.length > 0,
          loaded: true,
        },
      }));
    } catch {
      setData((prev) => ({ ...prev, [seg]: { ...prev[seg], loaded: true } }));
    }
  };

  const loadCoverage = (): Promise<DataHealth | null> =>
    getHealth()
      .then((h) => {
        setScrapeInfo({
          DAM: h.segments.DAM ?? null,
          RTM: h.segments.RTM ?? null,
          TAM: h.segments.TAM ?? null,
        });
        return h;
      })
      .catch(() => null);

  const handleScrape = async (seg: Segment) => {
    setScraping((prev) => ({ ...prev, [seg]: true }));
    setScrapeError((prev) => ({ ...prev, [seg]: null }));
    const windows = syncWindows(fetchDays);
    const failures: string[] = [];
    for (const [i, [start, end]] of windows.entries()) {
      if (windows.length > 1) {
        setProgress((prev) => ({ ...prev, [seg]: `${i + 1}/${windows.length}` }));
      }
      try {
        await triggerScrape(seg, start, end);
      } catch (err) {
        const message = errorMessage(err, "Scrape failed.");
        failures.push(windows.length > 1 ? `${message} (${start} to ${end})` : message);
      }
    }
    const synced = windows.length - failures.length;
    if (failures.length) {
      setScrapeError((prev) => ({
        ...prev,
        [seg]: synced
          ? `${failures.length} of ${windows.length} batches failed: ${failures[0]}`
          : `Sync failed: ${failures[0]}`,
      }));
    }
    const health = await loadCoverage();
    if (synced) await loadSegment(seg, hasForecast(health, seg));
    setProgress((prev) => ({ ...prev, [seg]: null }));
    setScraping((prev) => ({ ...prev, [seg]: false }));
  };

  const handleSyncAll = async () => {
    setSyncingAll(true);
    for (const seg of SEGMENTS) {
      await handleScrape(seg);
    }
    setSyncingAll(false);
  };

  useEffect(() => {
    loadCoverage().then((health) =>
      SEGMENTS.forEach((seg) => loadSegment(seg, hasForecast(health, seg))),
    );
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Market Data Sync"
        description="Fetch and synchronize cleared prices from IEX for every trading segment"
      />

      {/* Sync Controls */}
      <div className="card">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-3">
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                Data Range
              </label>
              <select
                id="sync-range"
                name="sync-range"
                value={fetchDays}
                onChange={(e) => setFetchDays(Number(e.target.value))}
                className="select-field text-sm min-w-[140px]"
              >
                {[
                  { value: 1, label: "1 day" },
                  { value: 3, label: "3 days" },
                  { value: 7, label: "7 days" },
                  { value: 14, label: "14 days" },
                  { value: 30, label: "1 month" },
                  { value: 90, label: "3 months" },
                  { value: 180, label: "6 months" },
                  { value: 365, label: "1 year" },
                ].map(({ value, label }) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <p className="text-xs text-gray-500 pt-5">
              This will fetch the last{" "}
              <span className="font-medium text-gray-700">
                {fetchDays} {fetchDays === 1 ? "day" : "days"}
              </span>{" "}
              of data
              {fetchDays > SYNC_WINDOW_DAYS &&
                `, in ${syncWindows(fetchDays).length} batches of up to ${SYNC_WINDOW_DAYS} days`}
            </p>
          </div>
          <button
            onClick={handleSyncAll}
            disabled={syncingAll || Object.values(scraping).some(Boolean)}
            className="btn-teal flex items-center gap-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {syncingAll || Object.values(scraping).some(Boolean) ? (
              <>
                <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 100 16v-4l-3 3 3 3v-4a8 8 0 01-8-8z" />
                </svg>
                Syncing…
              </>
            ) : (
              <>
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Sync All Markets
              </>
            )}
          </button>
        </div>
      </div>

      {/* Market Segments */}
      {SEGMENTS.map((seg) => {
        const meta = SEGMENT_META[seg];
        const state = data[seg];
        const isScrapingThis = scraping[seg];
        const hasData = state.points.length > 0;
        const latestDate = scrapeInfo[seg]?.latest_data;

        const daysSinceUpdate = latestDate
          ? Math.floor((new Date().getTime() - new Date(latestDate).getTime()) / (1000 * 60 * 60 * 24))
          : null;
        const isStale = daysSinceUpdate !== null && daysSinceUpdate > 2;

        return (
          <div key={seg} className="card">
            {/* Segment Header */}
            <div className="flex items-start justify-between mb-3 pb-3 border-b border-gray-100">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-bold px-2 py-0.5 rounded border border-gray-300 bg-gray-50 text-gray-700">
                    {seg}
                  </span>
                  <span className="text-sm font-semibold text-gray-800">
                    {meta.label}
                  </span>
                  {isScrapingThis && (
                    <span className="text-[10px] text-gray-500 flex items-center gap-1">
                      <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-pulse"></span>
                      Syncing…{progress[seg] && ` ${progress[seg]}`}
                    </span>
                  )}
                  {!isScrapingThis && hasData && !isStale && (
                    <span className="text-[10px] text-[#00B398] font-medium">● Up to date</span>
                  )}
                  {!isScrapingThis && isStale && (
                    <span className="text-[10px] text-amber-600 font-medium">⚠ {daysSinceUpdate}d old</span>
                  )}
                </div>
                <div className="flex items-center gap-4 text-[11px] text-gray-400">
                  <span>{meta.desc}</span>
                  {latestDate && (
                    <span>Last sync: <span className="text-gray-600">{latestDate}</span></span>
                  )}
                  {scrapeInfo[seg]?.row_count !== undefined && scrapeInfo[seg]!.row_count > 0 && (
                    <span>{scrapeInfo[seg]!.row_count.toLocaleString()} records</span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-3">
                {state.avgActual > 0 && (
                  <div className="text-right">
                    <div className="text-[10px] text-gray-400 uppercase tracking-wider">7-Day Avg</div>
                    <div className="text-base font-bold text-gray-800">₹{state.avgActual.toFixed(3)}</div>
                  </div>
                )}
                {state.avgPred !== null && (
                  <div className="text-right border-l border-gray-200 pl-3">
                    <div className="text-[10px] text-gray-400 uppercase tracking-wider">Forecast Avg</div>
                    <div className="text-base font-bold text-[#00B398]">₹{state.avgPred.toFixed(3)}</div>
                  </div>
                )}
                <button
                  onClick={() => handleScrape(seg)}
                  disabled={isScrapingThis}
                  className="btn-primary flex items-center gap-1.5 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isScrapingThis ? (
                    <>
                      <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 100 16v-4l-3 3 3 3v-4a8 8 0 01-8-8z" />
                      </svg>
                      Syncing…
                    </>
                  ) : (
                    <>
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M1 4v6h6" /><path d="M23 20v-6h-6" />
                        <path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15" />
                      </svg>
                      Sync {seg}
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Error */}
            {scrapeError[seg] && (
              <div className="mb-3 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {scrapeError[seg]}
              </div>
            )}

            {/* Chart or Empty State */}
            {!state.loaded ? (
              <div className="h-56 bg-gray-50 animate-pulse rounded-lg flex items-center justify-center">
                <p className="text-xs text-gray-400">Loading {seg} data…</p>
              </div>
            ) : state.points.length > 0 ? (
              <div>
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart
                      data={state.points}
                      margin={{ top: MEASURE_MARGIN_TOP, right: 12, bottom: 4, left: 4 }}
                    >
                      <defs>
                        <linearGradient id={`histGrad-${seg}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={meta.color} stopOpacity={0.15} />
                          <stop offset="95%" stopColor={meta.color} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" vertical={false} />
                      <XAxis
                        dataKey="label"
                        fontSize={9}
                        stroke="#E5E7EB"
                        tick={{ fill: "#9CA3AF" }}
                        interval={Math.floor(state.points.length / 8)}
                        tickLine={false}
                      />
                      <YAxis
                        fontSize={9}
                        stroke="#E5E7EB"
                        tick={{ fill: "#9CA3AF" }}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(v) => `₹${v}`}
                        width={40}
                      />
                      <Tooltip content={<CustomTooltip />} />
                      {state.hasPred && (
                        <Area type="monotone" dataKey="band" stroke="none"
                          fill={meta.predColor} fillOpacity={0.12} name="95% interval"
                          connectNulls dot={false} activeDot={false} />
                      )}
                      <Area type="monotone" dataKey="actual" name="Historical MCP"
                        stroke={meta.color} strokeWidth={1.5}
                        fill={`url(#histGrad-${seg})`} dot={false}
                        connectNulls={false}
                        activeDot={{ r: 3, fill: meta.color, strokeWidth: 1.5, stroke: "white" }}
                      />
                      {state.hasPred && (
                        <Line type="monotone" dataKey="predicted" name="Forecast"
                          stroke={meta.predColor} strokeWidth={2} dot={false}
                          strokeDasharray="5 3" connectNulls
                          activeDot={{ r: 4, fill: meta.predColor, strokeWidth: 1.5, stroke: "white" }}
                        />
                      )}
                      <RangeMeasure
                        data={state.points}
                        xKey="label"
                        yKey="actual"
                        color={meta.color}
                        formatX={(p) => `${shortDate(p.date)} ${blockToTime(p.block)}`}
                        formatPrice={(v) => `₹${v.toFixed(3)}`}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-2 flex items-center justify-center gap-3 text-[10px] text-gray-400">
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: meta.color }}></span>
                    Historical MCP
                  </span>
                  {state.hasPred && (
                    <span className="flex items-center gap-1">
                      <span className="w-3 border-t-2 border-dashed" style={{ borderColor: meta.predColor }}></span>
                      Latest forecast
                    </span>
                  )}
                  <span>· {state.points.length} data points</span>
                </div>
              </div>
            ) : (
              <div className="h-40 flex flex-col items-center justify-center gap-2 text-center bg-gray-50 rounded-lg border border-dashed border-gray-200">
                <p className="text-xs font-medium text-gray-500">No data for {seg}</p>
                <p className="text-[11px] text-gray-400">
                  Click Sync {seg} to fetch prices, then train a model in{" "}
                  <Link href="/forecast" className="text-[#006DAE] hover:underline">Model Training</Link>.
                </p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
