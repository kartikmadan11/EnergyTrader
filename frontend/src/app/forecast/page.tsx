"use client";

import { useState, useEffect, useRef } from "react";
import {
  trainModel,
  getDataCoverage,
  getEnrichStatus,
  triggerEnrich,
  errorMessage,
  type EnrichStatus,
  type TrainConfig,
  type TrainResult,
  type TuneMethod,
  type TuneScoring,
} from "@/lib/api";
import PageHeader from "@/components/PageHeader";
import { SEGMENTS } from "@/lib/utils";

/* ─── Helpers ─────────────────────────────────────────────────────────── */
function NumInput({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  tooltip,
  className = "",
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  tooltip?: string;
  className?: string;
}) {
  return (
    <label className={`flex flex-col gap-0.5 ${className}`}>
      <span className="flex items-center gap-1 text-[10px] text-gray-500 uppercase tracking-wider">
        {label}
        {tooltip && (
          <span className="group relative inline-flex items-center">
            <span className="flex items-center justify-center w-3.5 h-3.5 rounded-full border border-gray-300 text-[9px] font-bold text-gray-400 cursor-help hover:border-gray-500 hover:text-gray-600 leading-none">
              ?
            </span>
            <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 rounded-md bg-gray-800 px-2.5 py-2 text-[11px] normal-case font-normal text-white shadow-lg opacity-0 group-hover:opacity-100 transition-opacity z-50 leading-relaxed">
              {tooltip}
            </span>
          </span>
        )}
      </span>
      <input
        type="number"
        className="input-field text-xs py-1 w-full"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <span className="relative inline-block w-9 h-5">
        <input
          type="checkbox"
          className="sr-only"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span
          className={`absolute inset-0 rounded-full transition-colors ${checked ? "bg-[#006DAE]" : "bg-gray-300"}`}
        />
        <span
          className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${checked ? "translate-x-4" : ""}`}
        />
      </span>
      <span className="text-xs text-gray-600">{label}</span>
    </label>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card">
      <p className="text-xs font-semibold text-gray-700 mb-3 uppercase tracking-wider">
        {title}
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {children}
      </div>
    </div>
  );
}

/* ─── Defaults ────────────────────────────────────────────────────────── */
const DEFAULT_HP = {
  max_iter: 300,
  max_depth: 8,
  learning_rate: 0.05,
  min_samples_leaf: 10,
  l2_regularization: 0.0,
  max_bins: 255,
  early_stopping: true,
  n_iter_no_change: 10,
  validation_fraction: 0.1,
};

const DEFAULT_FEATURES = {
  extra_lags: "",
  rolling_windows: "7",
  include_demand_supply_ratio: true,
  include_price_momentum: true,
  include_ema: true,
  ema_span: 7,
  include_weather: true,
  include_holidays: true,
  include_month_cyclic: true,
  include_price_range: true,
  include_summer_signal: true,
};

const DEFAULT_TUNING = {
  enabled: false,
  method: "random" as TuneMethod,
  n_iter: 30,
  cv_folds: 5,
  scoring: "neg_mean_absolute_percentage_error" as TuneScoring,
};

/* ─── Page ────────────────────────────────────────────────────────────── */
export default function TrainingPage() {
  const [segment, setSegment] = useState("DAM");
  const [testSize, setTestSize] = useState(0.2);
  const [shuffle, setShuffle] = useState(false);
  const [maxDays, setMaxDays] = useState<number | null>(null);
  const [hp, setHp] = useState({ ...DEFAULT_HP });
  const [features, setFeatures] = useState({ ...DEFAULT_FEATURES });
  const [tuning, setTuning] = useState({ ...DEFAULT_TUNING });

  const [training, setTraining] = useState(false);
  const [result, setResult] = useState<TrainResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Training data coverage
  const [dataCoverage, setDataCoverage] = useState<{
    dates: string[];
    totalDays: number;
    earliest: string;
    latest: string;
    dowCounts: Record<string, number>;
  } | null>(null);
  const [coverageLoading, setCoverageLoading] = useState(false);

  // Enrichment status
  const [enrichStatus, setEnrichStatus] = useState<EnrichStatus | null>(null);
  const [enrichRunning, setEnrichRunning] = useState(false);
  const [enrichMessage, setEnrichMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const unmounted = useRef(false);

  useEffect(() => {
    getEnrichStatus()
      .then(setEnrichStatus)
      .catch(() => setEnrichStatus(null));
    return () => {
      unmounted.current = true;
    };
  }, []);

  const handleEnrich = async () => {
    setEnrichRunning(true);
    setEnrichMessage(null);
    try {
      const before = (await getEnrichStatus()).unenriched_rows;
      await triggerEnrich({ overwrite: false });
      // Enrichment runs server-side in the background. Poll the backlog until it
      // empties or stops shrinking, for at most two minutes.
      let last = before;
      let stable = 0;
      for (let i = 0; i < 40 && !unmounted.current; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const s = await getEnrichStatus();
        setEnrichStatus(s);
        if (s.unenriched_rows === 0) break;
        stable = s.unenriched_rows === last && last < before ? stable + 1 : 0;
        if (stable >= 2) break;
        last = s.unenriched_rows;
      }
      const after = (await getEnrichStatus()).unenriched_rows;
      setEnrichMessage(
        after < before
          ? { ok: true, text: `Enriched ${(before - after).toLocaleString()} rows.` }
          : {
              ok: true,
              text: "Enrichment is still running in the background. Check back shortly.",
            },
      );
    } catch (e) {
      setEnrichMessage({ ok: false, text: errorMessage(e, "Enrichment failed.") });
    }
    setEnrichRunning(false);
  };

  useEffect(() => {
    setCoverageLoading(true);
    setDataCoverage(null);
    getDataCoverage(segment)
      .then(({ dates }) => {
        const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const dowCounts: Record<string, number> = {};
        for (const d of dates) {
          const label = DOW[new Date(d + "T00:00:00").getDay()];
          dowCounts[label] = (dowCounts[label] ?? 0) + 1;
        }
        setDataCoverage({
          dates,
          totalDays: dates.length,
          earliest: dates[0] ?? "",
          latest: dates[dates.length - 1] ?? "",
          dowCounts,
        });
      })
      .catch(() => setDataCoverage(null))
      .finally(() => setCoverageLoading(false));
  }, [segment]);

  const handleTrain = async () => {
    setTraining(true);
    setResult(null);
    setError(null);
    const config: TrainConfig = {
      segment,
      test_size: testSize,
      shuffle,
      max_days: maxDays ?? undefined,
      hyperparams: { ...hp },
      features: {
        extra_lags: features.extra_lags
          .split(",")
          .map((s) => parseInt(s.trim()))
          .filter((n) => !isNaN(n) && n > 0),
        rolling_windows: features.rolling_windows
          .split(",")
          .map((s) => parseInt(s.trim()))
          .filter((n) => !isNaN(n) && n > 0),
        include_demand_supply_ratio: features.include_demand_supply_ratio,
        include_price_momentum: features.include_price_momentum,
        include_ema: features.include_ema,
        ema_span: features.ema_span,
        include_weather: features.include_weather,
        include_holidays: features.include_holidays,
        include_month_cyclic: features.include_month_cyclic,
        include_price_range: features.include_price_range,
        include_summer_signal: features.include_summer_signal,
      },
      tuning: tuning.enabled
        ? {
            method: tuning.method,
            n_iter: tuning.n_iter,
            cv_folds: tuning.cv_folds,
            scoring: tuning.scoring,
          }
        : null,
    };
    try {
      const r = await trainModel(config);
      setResult(r);
    } catch (e) {
      setError(errorMessage(e, "Training failed."));
    }
    setTraining(false);
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Model Training"
        description="Train the gradient-boosted price forecasting model for each market segment"
        actions={
          <>
            <div className="flex h-9 rounded-lg overflow-hidden border border-[var(--border)] bg-white">
              {SEGMENTS.map((s) => (
                <button
                  key={s}
                  onClick={() => setSegment(s)}
                  aria-pressed={segment === s}
                  className={`px-3 text-xs font-semibold transition-colors ${
                    segment === s
                      ? "bg-[#006DAE] text-white"
                      : "bg-white text-gray-500 hover:text-gray-700"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
            <button
              onClick={handleTrain}
              disabled={training}
              className="btn-primary h-9 !py-0 disabled:opacity-60"
            >
              {training ? "Training…" : `Train ${segment} Model`}
            </button>
          </>
        }
      />

      {/* ── Result / error banners ── */}
      {result && (
        <div className="card bg-teal-50 border-teal-200 py-2">
          <p className="text-teal-700 text-xs font-medium">
            ✓ Model trained ·{" "}
            {result.metrics.mape !== null ? (
              <>
                MAPE <span className="font-mono">{result.metrics.mape}%</span>
              </>
            ) : (
              <>
                sMAPE <span className="font-mono">{result.metrics.smape}%</span>
              </>
            )}
            {" · "}MAE{" "}
            <span className="font-mono">₹{result.metrics.mae.toFixed(2)}</span>
            {" · "}Train samples{" "}
            <span className="font-mono">
              {result.metrics.train_size.toLocaleString()}
            </span>
            {" · "}Test samples{" "}
            <span className="font-mono">
              {result.metrics.test_size.toLocaleString()}
            </span>
            {result.metrics.best_params && <> · Hyperparameters auto-tuned</>}
          </p>
        </div>
      )}
      {error && (
        <div className="card bg-red-50 border-red-200 py-2">
          <p className="text-red-600 text-xs font-medium">⚠ {error}</p>
        </div>
      )}

      {/* ── Training Data Coverage ── */}
      <div className="card py-3 px-4">
        {coverageLoading && (
          <p className="text-[11px] text-gray-400">Loading data coverage…</p>
        )}
        {!coverageLoading && !dataCoverage && (
          <p className="text-[11px] text-red-400">
            No data found for {segment}. Run a scrape first.
          </p>
        )}
        {dataCoverage &&
          (() => {
            // Slice to maxDays most recent dates if set
            const activeDates =
              maxDays && maxDays < dataCoverage.totalDays
                ? dataCoverage.dates.slice(-maxDays)
                : dataCoverage.dates;
            const activeDaysCount = activeDates.length;
            const trainDays = Math.round(activeDaysCount * (1 - testSize));
            const testDays = activeDaysCount - trainDays;
            const trainEnd = activeDates[trainDays - 1] ?? "";
            const testStart = activeDates[trainDays] ?? "";

            // Recompute DOW counts for active window
            const DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
            const dowCounts: Record<string, number> = {};
            for (const d of activeDates) {
              const label = DOW[new Date(d + "T00:00:00").getDay()];
              dowCounts[label] = (dowCounts[label] ?? 0) + 1;
            }
            const DOW_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
            const maxDow = Math.max(...Object.values(dowCounts), 1);
            return (
              <div className="flex items-center gap-6 flex-wrap">
                {/* Stat pills */}
                <div className="flex items-center gap-4">
                  {[
                    {
                      label: "Using",
                      value: `${activeDaysCount} days`,
                      sub: `${activeDates[0]} - ${activeDates[activeDates.length - 1]}`,
                      color: "text-gray-700",
                    },
                    {
                      label: "Train",
                      value: `${trainDays} days`,
                      sub: `→ ${trainEnd}`,
                      color: "text-teal-600",
                    },
                    {
                      label: "Test",
                      value: `${testDays} days`,
                      sub: `${testStart} →`,
                      color: "text-amber-500",
                    },
                  ].map(({ label, value, sub, color }) => (
                    <div key={label} className="flex flex-col">
                      <span className="text-[10px] text-gray-400 uppercase tracking-wider leading-none mb-0.5">
                        {label}
                      </span>
                      <span className={`text-sm font-bold font-mono leading-none ${color}`}>
                        {value}
                      </span>
                      <span className="text-[10px] text-gray-400 font-mono mt-0.5">
                        {sub}
                      </span>
                    </div>
                  ))}
                </div>

                {/* Divider */}
                <div className="w-px h-10 bg-gray-200 hidden sm:block" />

                {/* Weekday bars */}
                <div className="flex items-end gap-1.5 h-10">
                  {DOW_ORDER.map((day) => {
                    const count = dowCounts[day] ?? 0;
                    const barH =
                      maxDow > 0 ? Math.round((count / maxDow) * 28) : 4;
                    return (
                      <div
                        key={day}
                        title={`${day}: ${count} days`}
                        className="flex flex-col items-center gap-0.5"
                      >
                        <div
                          className="w-5 rounded-sm bg-[#006DAE]/60"
                          style={{ height: `${Math.max(barH, 4)}px` }}
                        />
                        <span className="text-[9px] font-medium text-gray-400">
                          {day.slice(0, 2)}
                        </span>
                      </div>
                    );
                  })}
                </div>

                {/* Divider */}
                <div className="w-px h-10 bg-gray-200 hidden sm:block" />

                {/* Split bar */}
                <div className="flex flex-col gap-1 flex-1 min-w-[140px] max-w-[260px]">
                  <div className="flex rounded overflow-hidden h-4 w-full text-[9px] font-bold">
                    <div
                      className="bg-teal-500 text-white flex items-center justify-center"
                      style={{ width: `${(1 - testSize) * 100}%` }}
                    >
                      {Math.round((1 - testSize) * 100)}%
                    </div>
                    <div
                      className="bg-amber-400 text-white flex items-center justify-center"
                      style={{ width: `${testSize * 100}%` }}
                    >
                      {Math.round(testSize * 100)}%
                    </div>
                  </div>
                  <p className="text-[10px] text-gray-400 leading-tight">
                    {shuffle ? (
                      <span className="text-amber-500">
                        ⚠ Shuffle on: temporal order is lost
                      </span>
                    ) : (
                      "Temporal order preserved"
                    )}
                  </p>
                </div>
              </div>
            );
          })()}
      </div>

      {/* ── Split & Shuffle ── */}
      <div className="card">
        <p className="text-xs font-semibold text-gray-700 mb-3 uppercase tracking-wider">
          Split &amp; Shuffle
        </p>
        <div className="flex flex-wrap items-center gap-6">
          {/* Days of data */}
          <div>
            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">
              Training window{" "}
              <span className="normal-case font-normal text-gray-400">(most recent N days)</span>
            </p>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={30}
                max={dataCoverage?.totalDays ?? 365}
                step={7}
                value={maxDays ?? (dataCoverage?.totalDays ?? 365)}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setMaxDays(v === dataCoverage?.totalDays ? null : v);
                }}
                className="w-36 accent-[#006DAE]"
              />
              <span className="text-sm font-mono text-[#006DAE] w-24">
                {maxDays ? `${maxDays} days` : "All data"}
              </span>
            </div>
          </div>
          {/* Test size */}
          <div>
            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">
              Test Size{" "}
              <span className="normal-case font-normal text-gray-400">
                (held-out validation)
              </span>
            </p>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0.05}
                max={0.45}
                step={0.05}
                value={testSize}
                onChange={(e) => setTestSize(Number(e.target.value))}
                className="w-36 accent-[#006DAE]"
              />
              <span className="text-sm font-mono text-[#006DAE] w-10">
                {Math.round(testSize * 100)}%
              </span>
            </div>
          </div>
          <Toggle
            label="Shuffle training data"
            checked={shuffle}
            onChange={setShuffle}
          />
        </div>
      </div>

      {/* ── Hyperparameters ── */}
      <Card title="Hyperparameters (HistGradientBoosting)">
        <NumInput
          label="Max Iterations"
          value={hp.max_iter}
          onChange={(v) => setHp((p) => ({ ...p, max_iter: v }))}
          min={50}
          max={5000}
          step={50}
          tooltip="Total number of boosting rounds. Early stopping will halt before this if validation loss stops improving."
        />
        <NumInput
          label="Max Depth"
          value={hp.max_depth ?? 8}
          onChange={(v) => setHp((p) => ({ ...p, max_depth: v }))}
          min={2}
          max={30}
          step={1}
          tooltip="Maximum depth of each decision tree. Deeper trees capture more complex patterns but are prone to overfitting. Typical sweet spot: 4-12."
        />
        <NumInput
          label="Learning Rate"
          value={hp.learning_rate}
          onChange={(v) => setHp((p) => ({ ...p, learning_rate: v }))}
          min={0.001}
          max={1}
          step={0.005}
          tooltip="Shrinkage applied to each tree's contribution. Lower values generalise better but require more iterations."
        />
        <NumInput
          label="Min Samples Leaf"
          value={hp.min_samples_leaf}
          onChange={(v) => setHp((p) => ({ ...p, min_samples_leaf: v }))}
          min={1}
          max={200}
          step={1}
          tooltip="Minimum samples in a leaf node. Higher values smooth the model and reduce overfitting."
        />
        <NumInput
          label="L2 Regularisation"
          value={hp.l2_regularization}
          onChange={(v) => setHp((p) => ({ ...p, l2_regularization: v }))}
          min={0}
          max={10}
          step={0.1}
          tooltip="L2 penalty on leaf values. Increase if the model overfits historical price spikes."
        />
        <NumInput
          label="Max Bins"
          value={hp.max_bins}
          onChange={(v) => setHp((p) => ({ ...p, max_bins: v }))}
          min={10}
          max={255}
          step={5}
          tooltip="Bins for discretising continuous features. 255 is the maximum."
        />
        <NumInput
          label="N Iter No Change"
          value={hp.n_iter_no_change}
          onChange={(v) => setHp((p) => ({ ...p, n_iter_no_change: v }))}
          min={1}
          max={100}
          step={1}
          tooltip="Iterations with no improvement before early stopping triggers."
        />
        <NumInput
          label="Val Fraction"
          value={hp.validation_fraction}
          onChange={(v) => setHp((p) => ({ ...p, validation_fraction: v }))}
          min={0.05}
          max={0.4}
          step={0.05}
          tooltip="Fraction of training data held out for early-stopping validation."
        />
        <div className="col-span-2 flex items-center pt-1">
          <Toggle
            label="Early stopping"
            checked={hp.early_stopping}
            onChange={(v) => setHp((p) => ({ ...p, early_stopping: v }))}
          />
        </div>
      </Card>

      {/* ── Data Enrichment ── */}
      <div className="card py-3 px-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">
            Data Enrichment
          </h3>
          <button
            className="btn-teal text-xs py-1 px-3 disabled:opacity-50"
            onClick={handleEnrich}
            disabled={enrichRunning}
          >
            {enrichRunning ? "Enriching…" : "Enrich Now"}
          </button>
        </div>
        {enrichStatus ? (
          <div className="flex flex-wrap gap-4 text-xs text-gray-600">
            <span>
              Unenriched rows:{" "}
              <span
                className={
                  enrichStatus.unenriched_rows === 0
                    ? "text-green-600 font-semibold"
                    : "text-amber-600 font-semibold"
                }
              >
                {enrichStatus.unenriched_rows.toLocaleString()}
              </span>
            </span>
            {enrichStatus.date_range && (
              <span className="text-gray-400">
                ({enrichStatus.date_range.earliest} →{" "}
                {enrichStatus.date_range.latest})
              </span>
            )}
            {enrichStatus.unenriched_rows === 0 && (
              <span className="text-green-600">✓ All rows enriched</span>
            )}
          </div>
        ) : (
          <p className="text-xs text-gray-400">Checking enrichment status…</p>
        )}
        {enrichMessage && (
          <p
            className={`mt-2 text-xs ${enrichMessage.ok ? "text-green-700" : "text-red-600"}`}
          >
            {enrichMessage.text}
          </p>
        )}
        <p className="mt-2 text-[10px] text-gray-400">
          Fetches weather (wind, solar, cloud) from Open-Meteo ERA5 archive and
          computes holiday flags. Required before training with weather /
          holiday features.
        </p>
      </div>

      {/* ── Feature Engineering ── */}
      <Card title="Feature Engineering">
        <label className="flex flex-col gap-0.5 col-span-2">
          <span className="flex items-center gap-1 text-[10px] text-gray-500 uppercase tracking-wider">
            Extra Lag Days
            <span className="group relative inline-flex items-center">
              <span className="flex items-center justify-center w-3.5 h-3.5 rounded-full border border-gray-300 text-[9px] font-bold text-gray-400 cursor-help hover:border-gray-500 hover:text-gray-600 leading-none">
                ?
              </span>
              <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 rounded-md bg-gray-800 px-2.5 py-2 text-[11px] normal-case font-normal text-white shadow-lg opacity-0 group-hover:opacity-100 transition-opacity z-50 leading-relaxed">
                Additional historical days as features. E.g. &quot;2,3,14&quot;
                adds price from 2, 3, and 14 days ago. Day-1 lag is always
                included.
              </span>
            </span>
          </span>
          <input
            className="input-field text-xs py-1"
            value={features.extra_lags}
            placeholder="e.g. 2,3,14"
            onChange={(e) =>
              setFeatures((p) => ({ ...p, extra_lags: e.target.value }))
            }
          />
        </label>
        <label className="flex flex-col gap-0.5 col-span-2">
          <span className="flex items-center gap-1 text-[10px] text-gray-500 uppercase tracking-wider">
            Rolling Windows (days)
            <span className="group relative inline-flex items-center">
              <span className="flex items-center justify-center w-3.5 h-3.5 rounded-full border border-gray-300 text-[9px] font-bold text-gray-400 cursor-help hover:border-gray-500 hover:text-gray-600 leading-none">
                ?
              </span>
              <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 rounded-md bg-gray-800 px-2.5 py-2 text-[11px] normal-case font-normal text-white shadow-lg opacity-0 group-hover:opacity-100 transition-opacity z-50 leading-relaxed">
                Window sizes for rolling mean and std features. E.g.
                &quot;7,14&quot; adds 7-day and 14-day rolling averages.
              </span>
            </span>
          </span>
          <input
            className="input-field text-xs py-1"
            value={features.rolling_windows}
            placeholder="e.g. 7,14"
            onChange={(e) =>
              setFeatures((p) => ({ ...p, rolling_windows: e.target.value }))
            }
          />
        </label>
        <NumInput
          label="EMA Span"
          value={features.ema_span}
          onChange={(v) => setFeatures((p) => ({ ...p, ema_span: v }))}
          min={2}
          max={30}
          step={1}
          tooltip="Window size for the exponential moving average feature."
        />
        <div className="col-span-3 flex flex-wrap gap-4 items-center pt-1">
          <Toggle
            label="D/S ratio"
            checked={features.include_demand_supply_ratio}
            onChange={(v) =>
              setFeatures((p) => ({ ...p, include_demand_supply_ratio: v }))
            }
          />
          <Toggle
            label="Price momentum"
            checked={features.include_price_momentum}
            onChange={(v) =>
              setFeatures((p) => ({ ...p, include_price_momentum: v }))
            }
          />
          <Toggle
            label="EMA"
            checked={features.include_ema}
            onChange={(v) => setFeatures((p) => ({ ...p, include_ema: v }))}
          />
        </div>
        {/* New feature groups */}
        <div className="col-span-4 border-t border-gray-100 pt-3 mt-1">
          <p className="text-[10px] text-gray-400 uppercase tracking-wider mb-2">New features (run enrichment first)</p>
          <div className="flex flex-wrap gap-4">
            <div className="flex flex-col gap-0.5">
              <Toggle
                label="Weather"
                checked={features.include_weather}
                onChange={(v) => setFeatures((p) => ({ ...p, include_weather: v }))}
              />
              <span className="text-[10px] text-gray-400 ml-11">wind, solar, cloud</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <Toggle
                label="Holidays"
                checked={features.include_holidays}
                onChange={(v) => setFeatures((p) => ({ ...p, include_holidays: v }))}
              />
              <span className="text-[10px] text-gray-400 ml-11">is_holiday, days_to_holiday</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <Toggle
                label="Month cyclic"
                checked={features.include_month_cyclic}
                onChange={(v) => setFeatures((p) => ({ ...p, include_month_cyclic: v }))}
              />
              <span className="text-[10px] text-gray-400 ml-11">sin/cos encoding</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <Toggle
                label="Price range"
                checked={features.include_price_range}
                onChange={(v) => setFeatures((p) => ({ ...p, include_price_range: v }))}
              />
              <span className="text-[10px] text-gray-400 ml-11">7-day high−low spread</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <Toggle
                label="Summer signal"
                checked={features.include_summer_signal}
                onChange={(v) => setFeatures((p) => ({ ...p, include_summer_signal: v }))}
              />
              <span className="text-[10px] text-gray-400 ml-11">is_summer + max_temp_7d</span>
            </div>
          </div>
        </div>
      </Card>

      {/* ── Auto-Tuning ── */}
      <Card title="Auto-Tuning (Hyperparameter Search)">
        <div className="col-span-4 flex items-center gap-6 pb-1">
          <Toggle
            label="Enable auto-tuning"
            checked={tuning.enabled}
            onChange={(v) => setTuning((p) => ({ ...p, enabled: v }))}
          />
        </div>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-gray-500 uppercase tracking-wider">
            Method
          </span>
          <select
            className="select-field text-xs py-1"
            value={tuning.method}
            onChange={(e) =>
              setTuning((p) => ({ ...p, method: e.target.value as TuneMethod }))
            }
          >
            <option value="random">Random Search</option>
            <option value="grid">Grid Search</option>
          </select>
        </label>
        <NumInput
          label="Iterations"
          value={tuning.n_iter}
          onChange={(v) => setTuning((p) => ({ ...p, n_iter: v }))}
          min={5}
          max={200}
          step={5}
          tooltip="Random parameter combinations to evaluate. Ignored for Grid Search."
        />
        <NumInput
          label="CV Folds"
          value={tuning.cv_folds}
          onChange={(v) => setTuning((p) => ({ ...p, cv_folds: v }))}
          min={2}
          max={10}
          step={1}
          tooltip="Cross-validation folds. More folds = more robust estimate but slower."
        />
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-gray-500 uppercase tracking-wider">
            Scoring
          </span>
          <select
            className="select-field text-xs py-1"
            value={tuning.scoring}
            onChange={(e) =>
              setTuning((p) => ({ ...p, scoring: e.target.value as TuneScoring }))
            }
          >
            <option value="neg_mean_absolute_percentage_error">MAPE</option>
            <option value="neg_mean_squared_error">MSE</option>
            <option value="r2">R²</option>
          </select>
        </label>
      </Card>
    </div>
  );
}
