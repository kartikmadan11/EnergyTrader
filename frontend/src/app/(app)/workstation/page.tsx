"use client";

import { useState, useEffect } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  CartesianGrid,
} from "recharts";
import Link from "next/link";
import PageHeader from "@/components/PageHeader";
import {
  predictPrices,
  recommendBids,
  submitBids,
  validateBids,
  assessRisk,
  autoTuneLambdas,
  requestApproval,
  errorMessage,
  type ApprovalResult,
  type BidRecommendation,
  type ForecastBlock,
  type RiskResult,
  type SubmitResult,
  type ValidationResult,
} from "@/lib/api";
import {
  blockToTime,
  SEGMENTS,
  STRATEGIES,
  getTomorrowDate,
  formatINR,
  newSessionId,
} from "@/lib/utils";
import Spinner from "@/components/Spinner";

// ── Types ────────────────────────────────────────────────────────────────────

/** A recommended bid joined with its forecast and any trader override. */
interface BidRow extends BidRecommendation {
  predicted_price: number;
  confidence_low: number;
  confidence_high: number;
  is_overridden: boolean;
  override_reason: string;
}

type Stage =
  | "idle"
  | "forecasting"
  | "forecasted"
  | "loading_bids"
  | "ready"
  | "validating"
  | "validated"
  | "reviewing"
  | "reviewed"
  | "submitting"
  | "submitted";

// ── Constants ────────────────────────────────────────────────────────────────

const STRATEGY_META = {
  conservative: {
    label: "Conservative",
    color: "#22c55e",
    activeClass: "bg-green-700 text-white border-green-600",
    hint: "High λ · DSM-safe · spread volume",
  },
  balanced: {
    label: "Balanced",
    color: "#006DAE",
    activeClass: "bg-[#006DAE] text-white border-[#005A91]",
    hint: "Medium λ · balanced risk/value",
  },
  aggressive: {
    label: "Aggressive",
    color: "#ef4444",
    activeClass: "bg-red-700 text-white border-red-600",
    hint: "Low λ · max value · accepts DSM risk",
  },
} as const;

const BUSY_STAGES: Stage[] = [
  "forecasting",
  "loading_bids",
  "validating",
  "reviewing",
  "submitting",
];

// Display names for the model's engineered features (forecast_service/model.py).
const FEATURE_LABELS: Record<string, { label: string; tip: string }> = {
  lag_price_1d: { label: "Price, 1 day ago", tip: "Same block on the previous day" },
  lag_price_7d: { label: "Price, 7 days ago", tip: "Same block one week earlier" },
  rolling_avg_7d: { label: "7-day average", tip: "Mean price for this block over the last 7 days" },
  rolling_std_7d: { label: "7-day volatility", tip: "Standard deviation of this block's price over 7 days" },
  rolling_median_7d: { label: "7-day median", tip: "Median price for this block over the last 7 days" },
  same_dow_avg_4w: { label: "Same weekday, 4 weeks", tip: "Average price for this block on the same weekday" },
  ema_price: { label: "Price EMA", tip: "Exponential moving average of recent prices" },
  price_momentum: { label: "Price momentum", tip: "Change in price over recent days" },
  price_range_7d: { label: "7-day price range", tip: "Max minus min price over 7 days" },
  demand_supply_ratio: { label: "Demand / supply", tip: "Previous-day demand over available supply" },
  renewable_share: { label: "Renewable share", tip: "Previous-day renewable generation over demand" },
  lag_demand_1d: { label: "Demand, 1 day ago", tip: "Previous-day grid demand (MW)" },
  lag_supply_1d: { label: "Supply, 1 day ago", tip: "Previous-day available supply (MW)" },
  lag_renewable_1d: { label: "Renewables, 1 day ago", tip: "Previous-day solar and wind generation (MW)" },
  temperature: { label: "Temperature", tip: "Drives cooling and heating load" },
  max_temp_7d: { label: "7-day max temperature", tip: "Heat build-up over the past week" },
  hour: { label: "Hour of day", tip: "Peak and off-peak patterns" },
  block_in_hour: { label: "Block in hour", tip: "Quarter-hour within the hour" },
  block_sin: { label: "Time of day (sin)", tip: "Cyclical encoding of the 15-minute block" },
  block_cos: { label: "Time of day (cos)", tip: "Cyclical encoding of the 15-minute block" },
  day_of_week: { label: "Day of week", tip: "Weekday versus weekend demand" },
  is_weekend: { label: "Weekend", tip: "Lower industrial demand at weekends" },
  is_holiday: { label: "Holiday", tip: "National holiday flag" },
  days_to_holiday: { label: "Days to holiday", tip: "Distance to the nearest national holiday" },
  month: { label: "Month", tip: "Seasonal pattern" },
  month_sin: { label: "Season (sin)", tip: "Cyclical encoding of the month" },
  month_cos: { label: "Season (cos)", tip: "Cyclical encoding of the month" },
  is_summer: { label: "Summer", tip: "April to June peak-cooling season" },
  wind_speed_ms: { label: "Wind speed", tip: "Open-Meteo wind speed (m/s)" },
  solar_radiation_wm2: { label: "Solar radiation", tip: "Open-Meteo shortwave radiation (W/m²)" },
  cloud_cover_pct: { label: "Cloud cover", tip: "Open-Meteo cloud cover (%)" },
};

const OVERRIDE_REASONS = [
  "Market intelligence",
  "Demand forecast adjustment",
  "Risk mitigation",
  "Regulatory requirement",
  "Manager directive",
  "Other",
];

// Lambda defaults mirror backend/common/solver_config.py
const LAMBDA1_DEFAULT = 2.0;
const LAMBDA2_DEFAULT = 1.5;

// Risk tolerance by strategy, mirroring backend/common/config.py STRATEGY_PROFILES.
const STRATEGY_RISK_TOLERANCE: Record<string, number> = {
  conservative: 0.3,
  balanced: 0.6,
  aggressive: 0.9,
};

// ── Sub-components ───────────────────────────────────────────────────────────

function RiskMetric({
  label,
  value,
  color,
  sub,
}: {
  label: string;
  value: string;
  color: string;
  sub?: string;
}) {
  return (
    <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 hover:shadow-md transition-shadow">
      <span className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider block mb-1">
        {label}
      </span>
      <span className="text-lg font-bold block" style={{ color }}>
        {value}
      </span>
      {sub && (
        <span className="text-[10px] text-gray-500 mt-0.5 block">{sub}</span>
      )}
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function WorkspacePage() {
  // Controls
  const [segment, setSegment] = useState<string>("DAM");
  const [strategy, setStrategy] =
    useState<(typeof STRATEGIES)[number]>("balanced");
  const [targetDate, setTargetDate] = useState(getTomorrowDate());
  const [demandMw, setDemandMw] = useState(500);
  const [demandMwInput, setDemandMwInput] = useState("500");
  const [lambda1, setLambda1] = useState<number | null>(null); // null = use solver_config default
  const [lambda2, setLambda2] = useState<number | null>(null);
  const [tuneOpen, setTuneOpen] = useState(false);
  const [autoTuning, setAutoTuning] = useState(false);
  const [tuneScore, setTuneScore] = useState<number | null>(null);

  // Data
  const [forecastBlocks, setForecastBlocks] = useState<ForecastBlock[]>([]);
  const [bidRows, setBidRows] = useState<BidRow[]>([]);
  const [liveRisk, setLiveRisk] = useState<RiskResult | null>(null);
  const [riskLoading, setRiskLoading] = useState(false);

  // Workflow
  const [stage, setStage] = useState<Stage>("idle");
  // Identifies the current bid set from its pre-trade checks through to submission, so
  // the blotter shows the checks in the session's history and a repeat submit is refused.
  const [draftId, setDraftId] = useState(newSessionId);
  const [submitResult, setSubmitResult] = useState<SubmitResult | null>(null);
  const [validationResult, setValidationResult] =
    useState<ValidationResult | null>(null);
  const [approvalResult, setApprovalResult] = useState<ApprovalResult | null>(null);
  const [approvalOpen, setApprovalOpen] = useState(true);
  const [error, setError] = useState("");

  // UI
  const [chartOpen, setChartOpen] = useState(true);
  const [editingReasonBlock, setEditingReasonBlock] = useState<number | null>(
    null,
  );

  const busy = BUSY_STAGES.includes(stage) || autoTuning;
  const submitted = stage === "submitted";

  const clearBids = () => {
    setBidRows([]);
    setDraftId(newSessionId());
    setLiveRisk(null);
    setRiskLoading(false);
    setSubmitResult(null);
    setValidationResult(null);
    setApprovalResult(null);
  };

  // A forecast belongs to one delivery date and segment; changing either starts over.
  const changeMarket = (date: string, seg: string) => {
    if (date === targetDate && seg === segment) return;
    setTargetDate(date);
    setSegment(seg);
    setForecastBlocks([]);
    clearBids();
    setTuneScore(null);
    setError("");
    setStage("idle");
  };

  // Bids belong to one strategy; changing it keeps the forecast but drops the bids
  // and any manual lambda overrides.
  const changeStrategy = (next: (typeof STRATEGIES)[number]) => {
    if (next === strategy) return;
    setStrategy(next);
    setLambda1(null);
    setLambda2(null);
    setTuneScore(null);
    clearBids();
    if (forecastBlocks.length > 0) setStage("forecasted");
  };

  // ── Live risk debounce ──────────────────────────────────────────────────
  // Re-assess 600 ms after the last edit. A newer edit cancels the pending call and
  // discards any response still in flight for the older bids.
  useEffect(() => {
    if (bidRows.length === 0) return;
    let current = true;
    const timer = setTimeout(async () => {
      setRiskLoading(true);
      try {
        const result = await assessRisk(
          `ws-${Date.now()}`,
          targetDate,
          segment,
          bidRows.map((b) => ({
            block: b.block,
            segment: b.segment,
            price: b.price,
            volume_mw: b.volume_mw,
          })),
        );
        if (current) setLiveRisk(result);
      } catch {
        // Keep the last result; the panel is advisory and refreshes on the next edit.
      }
      if (current) setRiskLoading(false);
    }, 600);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [bidRows, segment, targetDate]);

  // ── Actions ─────────────────────────────────────────────────────────────

  const bidPayload = () =>
    bidRows.map((b) => ({
      block: b.block,
      segment: b.segment,
      price: b.price,
      volume_mw: b.volume_mw,
      is_overridden: b.is_overridden,
      override_reason: b.override_reason || undefined,
    }));

  const handleForecast = async () => {
    setStage("forecasting");
    setError("");
    clearBids();
    try {
      const data = await predictPrices(targetDate, segment);
      setForecastBlocks(data.blocks);
      setStage("forecasted");
    } catch (e) {
      setError(errorMessage(e, "Forecast failed. Check that the API is running."));
      setStage("idle");
    }
  };

  const handleGetBids = async (
    l1Override?: number | null,
    l2Override?: number | null,
  ) => {
    if (forecastBlocks.length === 0) {
      setError("Generate a forecast first.");
      return;
    }
    setStage("loading_bids");
    setError("");
    setSubmitResult(null);
    setValidationResult(null);
    setApprovalResult(null);
    // Use freshly passed values (e.g. from auto-tune) or fall back to state.
    const rt = STRATEGY_RISK_TOLERANCE[strategy];
    const l1 = l1Override !== undefined ? l1Override : lambda1;
    const l2 = l2Override !== undefined ? l2Override : lambda2;
    try {
      const recs = await recommendBids(
        targetDate,
        strategy,
        segment,
        demandMw,
        {
          // The optimizer applies (1 - risk_tolerance) x base, so send the base.
          lambda1_base: l1 !== null ? l1 / (1 - rt) : null,
          lambda2_base: l2 !== null ? l2 / (1 - rt) : null,
        },
      );
      const merged: BidRow[] = recs.map((r) => {
        const fc = forecastBlocks.find((f) => f.block === r.block);
        return {
          ...r,
          predicted_price: fc?.predicted_price ?? r.price,
          confidence_low: fc?.confidence_low ?? r.price,
          confidence_high: fc?.confidence_high ?? r.price,
          is_overridden: false,
          override_reason: "",
        };
      });
      setBidRows(merged);
      setDraftId(newSessionId());
      setStage("ready");
    } catch (e) {
      setError(errorMessage(e, "Failed to get bid recommendations."));
      setStage("forecasted");
    }
  };

  const handleCellEdit = (
    block: number,
    field: "price" | "volume_mw",
    value: string,
  ) => {
    const num = parseFloat(value);
    if (isNaN(num)) return;
    setBidRows((prev) =>
      prev.map((b) =>
        b.block === block ? { ...b, [field]: num, is_overridden: true } : b,
      ),
    );
    // An edited schedule has to be validated and checked again before submission.
    setValidationResult(null);
    setApprovalResult(null);
    setStage((s) => (s === "validated" || s === "reviewed" ? "ready" : s));
  };

  const handleValidate = async () => {
    setStage("validating");
    setError("");
    try {
      setValidationResult(await validateBids(bidPayload()));
      setStage("validated");
    } catch (e) {
      setError(errorMessage(e, "Validation failed."));
      setStage("ready");
    }
  };

  const handleRequestApproval = async () => {
    setStage("reviewing");
    setError("");
    setApprovalResult(null);
    try {
      const result = await requestApproval(
        draftId,
        targetDate,
        segment,
        strategy,
        bidPayload(),
      );
      setApprovalResult(result);
      setApprovalOpen(true);
      setStage("reviewed");
    } catch (e) {
      setError(errorMessage(e, "Could not run pre-trade checks."));
      setStage(validationResult ? "validated" : "ready");
    }
  };

  const handleSubmit = async () => {
    setStage("submitting");
    setError("");
    try {
      setSubmitResult(
        await submitBids(draftId, targetDate, strategy, segment, bidPayload()),
      );
      setStage("submitted");
    } catch (e) {
      // A 422 from the submit gate carries the server's own verdict; show it.
      const detail = (e as { response?: { data?: { detail?: unknown } } })
        ?.response?.data?.detail as
        | Pick<ApprovalResult, "verdict" | "checks"> & { message: string }
        | undefined;
      if (detail && typeof detail === "object" && "verdict" in detail) {
        setApprovalResult((prev) =>
          prev
            ? {
                ...prev,
                verdict: detail.verdict,
                checks: detail.checks,
                summary: detail.message,
                can_submit: false,
              }
            : prev,
        );
        setApprovalOpen(true);
      }
      setError(errorMessage(e, "Submission failed."));
      setStage("reviewed");
    }
  };

  // ── Derived metrics ──────────────────────────────────────────────────────

  const strategyRiskTolerance = STRATEGY_RISK_TOLERANCE[strategy];
  // lambda1/lambda2 hold the effective weights (after risk-tolerance scaling);
  // null means "use the strategy default".
  const effectiveLambda1 =
    lambda1 ?? (1 - strategyRiskTolerance) * LAMBDA1_DEFAULT;
  const effectiveLambda2 =
    lambda2 ?? (1 - strategyRiskTolerance) * LAMBDA2_DEFAULT;

  const handleAutoTune = async () => {
    if (forecastBlocks.length === 0) {
      setError("Generate a forecast before auto-tuning.");
      return;
    }
    setAutoTuning(true);
    setError("");
    try {
      const result = await autoTuneLambdas(
        targetDate,
        strategy,
        segment,
        demandMw,
      );
      // Convert the returned bases to effective weights for the sliders.
      const newL1 = result.best_lambda1_base * (1 - strategyRiskTolerance);
      const newL2 = result.best_lambda2_base * (1 - strategyRiskTolerance);
      setLambda1(newL1);
      setLambda2(newL2);
      setTuneScore(result.best_score);
      // Re-fetch bids with the new values now rather than waiting for a state flush.
      await handleGetBids(newL1, newL2);
    } catch (e) {
      setError(errorMessage(e, "Auto-tune failed."));
    }
    setAutoTuning(false);
  };

  const chartData = forecastBlocks.map((b) => ({
    block: b.block,
    price: b.predicted_price,
    band: [b.confidence_low, b.confidence_high] as [number, number],
  }));

  const totalVol = bidRows.reduce((s, b) => s + b.volume_mw, 0);
  const avgBidPrice =
    bidRows.length > 0
      ? bidRows.reduce((s, b) => s + b.price, 0) / bidRows.length
      : 0;
  const totalDsmEst = bidRows.reduce((s, b) => s + b.dsm_penalty_estimate, 0);
  const overrideCount = bidRows.filter((b) => b.is_overridden).length;
  const violationCount = bidRows.reduce(
    (s, b) => s + (b.constraint_violations?.length ?? 0),
    0,
  );
  // Weights the optimizer actually applied in the last solve.
  const appliedLambda1 = bidRows[0]?.effective_lambda1 ?? effectiveLambda1;
  const appliedLambda2 = bidRows[0]?.effective_lambda2 ?? effectiveLambda2;

  const avgForecastPrice =
    forecastBlocks.length > 0
      ? forecastBlocks.reduce((s, b) => s + b.predicted_price, 0) /
        forecastBlocks.length
      : 0;

  const stratMeta = STRATEGY_META[strategy];
  const exposurePct = liveRisk
    ? (liveRisk.total_exposure / liveRisk.var_threshold) * 100
    : 0;

  const actions = [
    {
      key: "forecast",
      label: "Generate Forecast",
      runningLabel: "Forecasting…",
      icon: "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z",
      onClick: handleForecast,
      running: stage === "forecasting",
      done: forecastBlocks.length > 0,
      disabled: busy,
    },
    {
      key: "bids",
      label: "Optimize Bids",
      runningLabel: "Optimizing…",
      icon: "M13 10V3L4 14h7v7l9-11h-7z",
      onClick: () => handleGetBids(),
      running: stage === "loading_bids",
      done: bidRows.length > 0,
      disabled: busy || forecastBlocks.length === 0,
    },
    {
      key: "validate",
      label: "Validate",
      runningLabel: "Validating…",
      icon: "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z",
      onClick: handleValidate,
      running: stage === "validating",
      done: validationResult?.valid === true,
      disabled: busy || submitted || bidRows.length === 0,
    },
    {
      key: "checks",
      label: "Pre-trade Checks",
      runningLabel: "Checking…",
      icon: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4",
      onClick: handleRequestApproval,
      running: stage === "reviewing",
      done: approvalResult?.can_submit === true,
      disabled: busy || submitted || bidRows.length === 0,
    },
    {
      key: "submit",
      label: submitted ? "Submitted" : "Submit",
      runningLabel: "Submitting…",
      icon: "M5 13l4 4L19 7",
      onClick: handleSubmit,
      running: stage === "submitting",
      done: submitted,
      disabled: !(stage === "reviewed" && approvalResult?.can_submit),
    },
  ];

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Trading Workstation"
        description="Forecast prices, optimize a 96-block bid schedule and run pre-trade checks before submission"
      />

      {/* ── Configuration Panel ─────────────────────────────────────────── */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold text-gray-800">
            Trading Parameters
          </h2>
          <button
            onClick={() => setTuneOpen((o) => !o)}
            className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border transition-all hover:shadow-md ${
              tuneOpen || lambda1 !== null || lambda2 !== null
                ? "border-[#006DAE] text-white bg-[#006DAE] shadow-sm"
                : "border-gray-300 text-gray-600 hover:border-[#006DAE] hover:text-[#006DAE]"
            }`}
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"
              />
            </svg>
            Optimizer Settings
            {(lambda1 !== null || lambda2 !== null) && (
              <span className="w-1.5 h-1.5 rounded-full bg-current" aria-label="overridden" />
            )}
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {/* Date */}
          <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
            <label className="block text-xs font-semibold text-gray-700 mb-2">
              Delivery Date
            </label>
            <input
              type="date"
              value={targetDate}
              onChange={(e) => e.target.value && changeMarket(e.target.value, segment)}
              disabled={busy}
              className="w-full px-3 py-2 text-sm border-2 border-gray-300 rounded-lg focus:outline-none focus:border-[#006DAE] focus:ring-2 focus:ring-[#006DAE]/20 transition-all disabled:opacity-60"
            />
          </div>

          {/* Segment */}
          <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
            <label className="block text-xs font-semibold text-gray-700 mb-2">
              Market Segment
            </label>
            <div className="flex h-9 rounded-lg overflow-hidden border-2 border-gray-300">
              {SEGMENTS.map((s) => (
                <button
                  key={s}
                  onClick={() => changeMarket(targetDate, s)}
                  disabled={busy}
                  className={`flex-1 text-xs font-bold transition-all disabled:cursor-not-allowed ${
                    segment === s
                      ? "bg-[#006DAE] text-white shadow-inner"
                      : "bg-white text-gray-600 hover:bg-gray-100"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Strategy */}
          <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
            <label className="block text-xs font-semibold text-gray-700 mb-2">
              Trading Strategy
            </label>
            <div className="flex h-9 rounded-lg overflow-hidden border-2 border-gray-300">
              {STRATEGIES.map((s) => (
                <button
                  key={s}
                  onClick={() => changeStrategy(s)}
                  disabled={busy}
                  className={`flex-auto whitespace-nowrap px-2 text-[11px] font-bold transition-all disabled:cursor-not-allowed ${
                    strategy === s
                      ? STRATEGY_META[s].activeClass + " shadow-inner"
                      : "bg-white text-gray-600 hover:bg-gray-100"
                  }`}
                >
                  {STRATEGY_META[s].label}
                </button>
              ))}
            </div>
            <p className="text-[9px] text-gray-500 mt-1.5 text-center">
              {STRATEGY_META[strategy].hint}
            </p>
          </div>

          {/* Demand */}
          <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
            <label className="block text-xs font-semibold text-gray-700 mb-2">
              Total Demand
            </label>
            <div className="relative">
              <input
                type="number"
                value={demandMwInput}
                onChange={(e) => {
                  setDemandMwInput(e.target.value);
                  const n = parseFloat(e.target.value);
                  if (!isNaN(n) && n > 0) setDemandMw(n);
                }}
                onBlur={() => {
                  const n = parseFloat(demandMwInput);
                  if (isNaN(n) || n <= 0) {
                    setDemandMwInput(String(demandMw));
                  } else {
                    setDemandMw(n);
                    setDemandMwInput(String(n));
                  }
                }}
                disabled={busy}
                className="w-full pl-3 pr-12 py-2 text-sm font-bold border-2 border-gray-300 rounded-lg focus:outline-none focus:border-[#006DAE] focus:ring-2 focus:ring-[#006DAE]/20 transition-all disabled:opacity-60 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400 pointer-events-none">
                MW
              </span>
            </div>
          </div>
        </div>

        {/* Workflow actions: each segment shows whether its step is pending, running or done. */}
        <div className="mt-4 flex w-full rounded-lg border border-gray-300 overflow-hidden divide-x divide-gray-300 shadow-sm">
          {actions.map((a) => (
            <button
              key={a.key}
              onClick={a.onClick}
              disabled={a.disabled}
              className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed focus:z-10 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#006DAE] ${
                a.running
                  ? "bg-[#006DAE] text-white"
                  : a.done
                    ? "bg-white text-[#00B398] enabled:hover:bg-gray-50"
                    : a.disabled
                      ? "bg-gray-50 text-gray-400"
                      : "bg-white text-gray-800 hover:bg-[#006DAE] hover:text-white"
              }`}
            >
              {a.running ? (
                <Spinner />
              ) : a.done ? (
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20" aria-hidden>
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                    clipRule="evenodd"
                  />
                </svg>
              ) : (
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={a.icon} />
                </svg>
              )}
              {a.running ? a.runningLabel : a.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Optimizer tuning panel ────────────────────────────────────── */}
      {tuneOpen && (
        <div className="card border-2 border-[#006DAE]/30 bg-white">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <svg
                  className="w-5 h-5 text-[#006DAE]"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"
                  />
                </svg>
                <h3 className="text-sm font-bold text-gray-900">
                  Optimizer Weights
                </h3>
              </div>
              <p className="text-xs text-gray-600 leading-relaxed max-w-2xl">
                Set how the LP optimizer trades bid value against DSM penalty
                risk and forecast uncertainty. Changes apply on the next
                optimization. Auto-tune grid-searches both weights and keeps
                the pair with the highest bid value minus twice the expected
                DSM penalty.
                {tuneScore !== null && (
                  <span className="ml-2 text-xs font-semibold text-[#006DAE] bg-white px-2 py-0.5 rounded-full border border-[#006DAE]/30 whitespace-nowrap">
                    Last auto-tune score: {formatINR(tuneScore)}
                  </span>
                )}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {(lambda1 !== null || lambda2 !== null) && (
                <button
                  onClick={() => {
                    setLambda1(null);
                    setLambda2(null);
                  }}
                  className="text-xs font-medium text-gray-600 hover:text-[#006DAE] hover:underline transition-colors"
                >
                  Reset All
                </button>
              )}
              <button
                onClick={handleAutoTune}
                disabled={busy || forecastBlocks.length === 0}
                className="flex items-center gap-2 text-sm font-bold px-4 py-2 rounded-lg border-2 border-[#006DAE] transition-all disabled:opacity-50 disabled:cursor-not-allowed bg-[#006DAE] text-white enabled:hover:bg-[#005a9e] enabled:hover:shadow-lg"
              >
                {autoTuning ? (
                  <>
                    <Spinner className="w-4 h-4" />
                    Tuning…
                  </>
                ) : (
                  <>
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M13 10V3L4 14h7v7l9-11h-7z"
                      />
                    </svg>
                    Auto-Tune Parameters
                  </>
                )}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* DSM Compliance pressure */}
            <div className="bg-white rounded-xl border-2 border-gray-200 px-5 py-4 hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-bold text-gray-900">
                      λ₁: DSM Compliance Pressure
                    </span>
                    {lambda1 !== null && (
                      <span className="text-[9px] font-bold text-white bg-[#006DAE] px-2 py-0.5 rounded-full">
                        OVERRIDE
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-600 leading-relaxed">
                    Controls how aggressively the optimizer stays within CERC
                    deviation bands.
                    <span className="block mt-1 text-[10px] text-gray-500">
                      <strong>Higher:</strong> Volume spread conservatively to
                      avoid penalties
                      <br />
                      <strong>Lower:</strong> Chases value even if risking
                      deviation charges
                    </span>
                  </p>
                </div>
                {lambda1 !== null && (
                  <button
                    onClick={() => setLambda1(null)}
                    className="shrink-0 ml-3 text-xs font-medium text-[#006DAE] hover:underline"
                  >
                    Reset
                  </button>
                )}
              </div>
              <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                <div className="flex items-center gap-3 mb-2">
                  <span className="text-xs text-gray-500 shrink-0">
                    Lenient
                  </span>
                  <input
                    type="range"
                    min={0.05}
                    max={5.0}
                    step={0.05}
                    value={effectiveLambda1}
                    onChange={(e) => setLambda1(parseFloat(e.target.value))}
                    className="flex-1 accent-[#006DAE] cursor-pointer"
                  />
                  <span className="text-xs text-gray-500 shrink-0">Strict</span>
                  <span
                    className={`text-sm font-semibold w-12 text-right shrink-0 tabular-nums ${lambda1 !== null ? "text-[#006DAE]" : "text-gray-500"}`}
                  >
                    {effectiveLambda1.toFixed(2)}
                  </span>
                </div>
                <p
                  className={`text-xs mt-1 ${lambda1 === null ? "text-gray-400" : "text-[#006DAE]"}`}
                >
                  {lambda1 === null
                    ? `Using strategy default: ${effectiveLambda1.toFixed(2)}`
                    : effectiveLambda1 >= 2.2
                      ? "Very strict - broad volume spread"
                      : effectiveLambda1 >= 1.2
                        ? "Moderately strict compliance"
                        : effectiveLambda1 <= 0.4
                          ? "Lenient - focused volume"
                          : "Balanced approach"}
                </p>
              </div>
            </div>

            {/* Forecast Confidence Caution */}
            <div className="bg-white rounded-xl border-2 border-gray-200 px-5 py-4 hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-semibold text-gray-800">
                      λ₂: Forecast Confidence Caution
                    </span>
                  </div>
                  <p className="text-xs text-gray-600 leading-relaxed">
                    Controls how much the optimizer avoids blocks with uncertain
                    price forecasts.
                    <span className="block mt-1 text-[10px] text-gray-500">
                      <strong>Higher:</strong> Volume shifted away from volatile
                      time-blocks
                      <br />
                      <strong>Lower:</strong> Treats all blocks equally despite
                      uncertainty
                    </span>
                  </p>
                </div>
                {lambda2 !== null && (
                  <button
                    onClick={() => setLambda2(null)}
                    className="shrink-0 ml-3 text-xs font-medium text-[#006DAE] hover:underline"
                  >
                    Reset
                  </button>
                )}
              </div>
              <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                <div className="flex items-center gap-3 mb-2">
                  <span className="text-xs text-gray-500 shrink-0">Ignore</span>
                  <input
                    type="range"
                    min={0.05}
                    max={1.1}
                    step={0.05}
                    value={effectiveLambda2}
                    onChange={(e) => setLambda2(parseFloat(e.target.value))}
                    className="flex-1 accent-[#006DAE] cursor-pointer"
                  />
                  <span className="text-xs text-gray-500 shrink-0">Avoid</span>
                  <span
                    className={`text-sm font-semibold w-12 text-right shrink-0 tabular-nums ${lambda2 !== null ? "text-[#006DAE]" : "text-gray-500"}`}
                  >
                    {effectiveLambda2.toFixed(2)}
                  </span>
                </div>
                <p
                  className={`text-xs mt-1 ${lambda2 === null ? "text-gray-400" : "text-[#006DAE]"}`}
                >
                  {lambda2 === null
                    ? `Using strategy default: ${effectiveLambda2.toFixed(2)}`
                    : effectiveLambda2 >= 0.9
                      ? "Strongly avoids uncertain blocks"
                      : effectiveLambda2 >= 0.6
                        ? "Moderately cautious"
                        : effectiveLambda2 <= 0.3
                          ? "Largely ignores uncertainty"
                          : "Balanced caution"}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Status banners ────────────────────────────────────────────── */}
      {error && (
        <div className="card py-2 bg-red-50 border-red-200 flex items-center gap-2" role="alert">
          <span className="text-red-600 text-xs">{error}</span>
          <button
            onClick={() => setError("")}
            className="ml-auto text-gray-400 hover:text-gray-700 text-xs"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}
      {validationResult && (
        <details
          className={`card py-2 group ${
            validationResult.valid
              ? "bg-teal-50 border-teal-200"
              : "bg-red-50 border-red-200"
          }`}
        >
          <summary className="flex items-center gap-2 cursor-pointer list-none">
            <span
              className={`text-xs font-medium flex-1 ${
                validationResult.valid ? "text-teal-700" : "text-red-600"
              }`}
            >
              {validationResult.valid
                ? approvalResult
                  ? "✓ All constraints pass."
                  : "✓ All constraints pass. Run the pre-trade checks to enable submission."
                : `⚠ ${validationResult.violation_count} constraint ${
                    validationResult.violation_count === 1 ? "violation" : "violations"
                  }. Review the highlighted rows.`}
            </span>
            <span className="text-[10px] text-gray-400 group-open:hidden">
              ▾ details
            </span>
            <span className="text-[10px] text-gray-400 hidden group-open:inline">
              ▴ hide
            </span>
          </summary>
          <div className="mt-3 pt-3 border-t border-teal-200/60 space-y-2 text-[11px] text-gray-600">
            <p className="font-semibold text-gray-700">
              Checked against the active DSM policy
            </p>
            <ul className="list-disc ml-5 space-y-1">
              <li>
                <span className="font-medium">Price band:</span> every bid
                price lies within the policy floor and ceiling
              </li>
              <li>
                <span className="font-medium">Technical minimum:</span> any
                non-zero DAM or RTM volume meets the minimum block size
              </li>
              <li>
                <span className="font-medium">Non-negative volume:</span> no
                block has a negative quantity
              </li>
            </ul>
            {bidRows[0]?.active_policy && (
              <p className="text-[10px] text-gray-500">
                Policy:{" "}
                <span className="font-mono font-medium text-gray-700">
                  {bidRows[0].active_policy}
                </span>
              </p>
            )}
            {!validationResult.valid && validationResult.violations.length > 0 && (
              <div className="mt-2">
                <p className="font-semibold text-red-600 mb-1">Violations</p>
                <ul className="space-y-0.5">
                  {validationResult.violations.map((v, i) => (
                    <li key={i} className="text-red-600">
                      Block {v.block} · {v.field}: {v.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </details>
      )}
      {/* ── Pre-trade check verdict ───────────────────────────────────── */}
      {approvalResult && (
        <div
          className={`card ${
            approvalResult.verdict === "APPROVED"
              ? "bg-teal-50 border-teal-300"
              : approvalResult.verdict === "APPROVED_WITH_FLAGS"
                ? "bg-amber-50 border-amber-300"
                : "bg-red-50 border-red-300"
          }`}
        >
          <div className={`flex items-center gap-3 ${approvalOpen ? "mb-3" : ""}`}>
            <span
              className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${
                approvalResult.verdict === "APPROVED"
                  ? "bg-teal-100 text-teal-700"
                  : approvalResult.verdict === "APPROVED_WITH_FLAGS"
                    ? "bg-amber-100 text-amber-700"
                    : approvalResult.verdict === "NEEDS_REVISION"
                      ? "bg-orange-100 text-orange-700"
                      : "bg-red-100 text-red-700"
              }`}
            >
              {approvalResult.verdict === "APPROVED" && "✓ "}
              {approvalResult.verdict === "APPROVED_WITH_FLAGS" && "⚠ "}
              {approvalResult.verdict === "NEEDS_REVISION" && "✎ "}
              {approvalResult.verdict === "REJECTED" && "✕ "}
              {approvalResult.verdict.replace(/_/g, " ")}
            </span>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      approvalResult.score >= 80
                        ? "bg-teal-500"
                        : approvalResult.score >= 55
                          ? "bg-amber-400"
                          : "bg-red-400"
                    }`}
                    style={{ width: `${approvalResult.score}%` }}
                  />
                </div>
                <span className="text-xs font-bold text-gray-700 w-12 text-right tabular-nums">
                  {approvalResult.score}/100
                </span>
              </div>
            </div>
            <span className="text-[10px] text-gray-500 font-medium">
              Pre-trade checks · {approvalResult.checks.length}
            </span>
            <button
              onClick={() => setApprovalOpen((o) => !o)}
              className="text-[10px] text-gray-400 hover:text-gray-600 transition-colors px-1.5 py-0.5 rounded hover:bg-black/5"
            >
              {approvalOpen ? "▴ hide" : "▾ show"}
            </button>
          </div>
          {approvalOpen && (
            <>
              <p className="text-[11px] text-gray-700 mb-3">{approvalResult.summary}</p>
              <div className="space-y-1">
                {approvalResult.checks.map((check) => (
                  <div
                    key={check.name}
                    className={`flex items-start gap-2 text-[11px] rounded-md px-2 py-1 ${
                      check.status === "pass"
                        ? "bg-teal-50/60"
                        : check.status === "warn"
                          ? "bg-amber-50/60"
                          : "bg-red-50/60"
                    }`}
                  >
                    <span className="shrink-0 text-[12px] mt-px">
                      {check.status === "pass" ? "✓" : check.status === "warn" ? "⚠" : "✕"}
                    </span>
                    <div className="flex-1 min-w-0">
                      <span
                        className={`text-[9px] font-bold uppercase tracking-wider mr-1.5 px-1 py-0.5 rounded ${
                          check.category === "hard"
                            ? "bg-gray-800 text-white"
                            : "bg-gray-200 text-gray-600"
                        }`}
                      >
                        {check.category}
                      </span>
                      <span className="font-medium text-gray-800">
                        {check.name.replace(/_/g, " ")}:
                      </span>
                      <span className="text-gray-600"> {check.message}</span>
                      {check.affected_blocks.length > 0 && (
                        <span className="text-[10px] text-gray-400 ml-1">
                          (blocks {check.affected_blocks.slice(0, 5).join(", ")}
                          {check.affected_blocks.length > 5 &&
                            ` +${check.affected_blocks.length - 5} more`}
                          )
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {!approvalResult.can_submit && (
                <p className="mt-3 text-[10px] text-gray-500 border-t border-red-200/60 pt-2">
                  Resolve the failing hard checks above, then run the pre-trade
                  checks again.
                </p>
              )}
            </>
          )}
        </div>
      )}
      {submitResult && (
        <div className="card py-3 bg-teal-50 border-teal-200 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="font-semibold text-teal-700">✓ Bids submitted</span>
          <span className="text-gray-600">
            {submitResult.bid_count} blocks · {submitResult.segment} ·{" "}
            {submitResult.target_date}
          </span>
          <span className="text-gray-600">
            Verdict {submitResult.verdict.replace(/_/g, " ").toLowerCase()} ·{" "}
            {submitResult.score}/100
          </span>
          <span className="font-mono text-[10px] text-gray-500">
            session {submitResult.session_id}
          </span>
          <Link
            href={`/blotter?session=${submitResult.session_id}`}
            className="ml-auto text-[11px] font-medium text-[#006DAE] hover:underline"
          >
            View in blotter →
          </Link>
          <Link
            href="/analysis"
            className="text-[11px] font-medium text-[#006DAE] hover:underline"
          >
            Post-market analysis →
          </Link>
        </div>
      )}

      {/* ── Main area: left grid + right risk panel ────────────────────── */}
      <div className="flex gap-4 items-start">
        {/* ── Left ── */}
        <div className="flex-1 min-w-0 flex flex-col gap-3">
          {/* Forecast chart (collapsible) */}
          {forecastBlocks.length > 0 && (
            <div className="card border-2 border-[#006DAE]/20 hover:border-[#006DAE]/40 transition-colors">
              <div
                className="flex items-center justify-between cursor-pointer select-none group"
                onClick={() => setChartOpen((o) => !o)}
              >
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg bg-[#006DAE] text-white flex items-center justify-center">
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                        />
                      </svg>
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-gray-900">
                        Price Forecast
                      </h3>
                      <p className="text-xs text-gray-500">
                        {segment} · {targetDate}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-xs">
                    <div className="bg-[#006DAE]/10 border border-[#006DAE]/30 rounded-lg px-3 py-1.5">
                      <span className="text-gray-600">Avg Price: </span>
                      <span className="font-bold text-[#006DAE]">
                        ₹{avgForecastPrice.toFixed(3)}/kWh
                      </span>
                    </div>
                    <div className="bg-gray-100 border border-gray-300 rounded-lg px-3 py-1.5">
                      <span className="text-gray-600">Blocks: </span>
                      <span className="font-bold text-gray-900">
                        {forecastBlocks.length}
                      </span>
                    </div>
                  </div>
                </div>
                <button className="flex items-center gap-2 text-xs font-semibold text-[#006DAE] hover:text-[#005A91] transition-colors px-3 py-1.5 rounded-lg hover:bg-[#006DAE]/5">
                  {chartOpen ? (
                    <>
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M5 15l7-7 7 7"
                        />
                      </svg>
                      Collapse Chart
                    </>
                  ) : (
                    <>
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M19 9l-7 7-7-7"
                        />
                      </svg>
                      Expand Chart
                    </>
                  )}
                </button>
              </div>

              {chartOpen && (
                <div className="mt-4 pt-4 border-t border-gray-200">
                  <div className="h-48 bg-gradient-to-br from-gray-50/50 to-blue-50/30 rounded-lg p-3">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart
                        data={chartData}
                        margin={{ top: 8, right: 12, bottom: 4, left: 4 }}
                      >
                        <CartesianGrid
                          strokeDasharray="3 3"
                          stroke="#E5E7EB"
                          vertical={false}
                        />
                        <XAxis
                          dataKey="block"
                          stroke="#9CA3AF"
                          fontSize={10}
                          interval={11}
                          tickFormatter={(b) => blockToTime(b)}
                        />
                        <YAxis
                          stroke="#9CA3AF"
                          fontSize={10}
                          tickFormatter={(v) => `₹${v}`}
                          width={50}
                        />
                        <Tooltip
                          contentStyle={{
                            background: "#FFFFFF",
                            border: "2px solid #E2E8F0",
                            borderRadius: "8px",
                            fontSize: "11px",
                            color: "#1E293B",
                            boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.1)",
                          }}
                          labelFormatter={(b) =>
                            `Block ${b} · ${blockToTime(Number(b))}`
                          }
                          formatter={(v, name) => [
                            // The confidence band is a [low, high] range.
                            Array.isArray(v)
                              ? `₹${Number(v[0]).toFixed(3)} to ₹${Number(v[1]).toFixed(3)}`
                              : `₹${Number(v).toFixed(3)}`,
                            name,
                          ]}
                        />
                        <ReferenceLine
                          y={avgForecastPrice}
                          stroke="#006DAE"
                          strokeDasharray="4 4"
                          strokeOpacity={0.6}
                          strokeWidth={2}
                        />
                        <Area
                          type="monotone"
                          dataKey="band"
                          stroke="transparent"
                          fill="#006DAE"
                          fillOpacity={0.12}
                          name="95% interval"
                          activeDot={false}
                        />
                        <Area
                          type="monotone"
                          dataKey="price"
                          stroke="#006DAE"
                          strokeWidth={2.5}
                          fill="none"
                          dot={false}
                          name="Forecast"
                          activeDot={{
                            r: 5,
                            fill: "#006DAE",
                            strokeWidth: 2,
                            stroke: "white",
                          }}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="mt-3 flex items-center justify-center gap-4 text-xs text-gray-600">
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-0.5 bg-[#006DAE]"></span>
                      Forecast
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-3 bg-[#006DAE]/20 border border-[#006DAE]"></span>
                      95% interval
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 border-t-2 border-dashed border-[#006DAE] opacity-60"></span>
                      Daily average
                    </span>
                  </div>
                </div>
              )}

              {/* Top price drivers, aggregated across all blocks */}
              {(() => {
                const agg = new Map<string, number>();
                for (const b of forecastBlocks) {
                  for (const f of b.top_features ?? []) {
                    agg.set(f.feature, (agg.get(f.feature) ?? 0) + f.importance);
                  }
                }
                const sorted = Array.from(agg.entries())
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 5);
                const maxVal = sorted[0]?.[1] ?? 1;
                if (sorted.length === 0) return null;
                return (
                  <div className="mt-4 pt-4 border-t border-gray-100">
                    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">
                      Top Price Drivers
                    </p>
                    <div className="flex flex-col gap-1.5">
                      {sorted.map(([feat, val]) => {
                        const pct = (val / maxVal) * 100;
                        const meta = FEATURE_LABELS[feat];
                        return (
                          <div key={feat} className="group relative flex items-center gap-2">
                            <span className="text-[10px] text-gray-500 w-36 shrink-0 truncate">
                              {meta?.label ?? feat.replace(/_/g, " ")}
                            </span>
                            <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden cursor-default">
                              <div
                                className="h-full rounded-full bg-[#006DAE] transition-opacity group-hover:opacity-70"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="text-[10px] text-gray-400 w-8 text-right tabular-nums">
                              {pct.toFixed(0)}%
                            </span>
                            {meta?.tip && (
                              <div className="pointer-events-none absolute left-0 bottom-full mb-1.5 z-20 hidden group-hover:flex">
                                <span className="whitespace-nowrap bg-gray-800 text-white text-[10px] rounded px-2 py-1 shadow-lg">
                                  {meta.tip}
                                </span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
            </div>
          )}

          {/* 96-block grid */}
          {bidRows.length > 0 && (
            <div className="card p-0 overflow-hidden border-2 border-gray-200">
              {/* Table header */}
              <div className="bg-gradient-to-r from-gray-50 to-gray-100 px-5 py-3 border-b-2 border-gray-200">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#006DAE] to-[#00B398] text-white flex items-center justify-center font-bold text-sm">
                        96
                      </div>
                      <div>
                        <h3 className="text-sm font-bold text-gray-900">
                          Optimized Bid Schedule
                        </h3>
                        <p className="text-xs text-gray-600">
                          {segment} ·{" "}
                          <span className="capitalize">{strategy}</span>{" "}
                          Strategy
                        </p>
                      </div>
                    </div>
                    <span
                      className="text-xs px-3 py-1 rounded-lg font-semibold border-2"
                      style={{
                        color: stratMeta.color,
                        background: `${stratMeta.color}15`,
                        borderColor: `${stratMeta.color}40`,
                      }}
                    >
                      {stratMeta.hint}
                    </span>
                  </div>
                  <div className="flex items-center gap-4">
                    {overrideCount > 0 && (
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 bg-amber-100 border border-amber-300 px-3 py-1 rounded-lg">
                        <svg
                          className="w-3.5 h-3.5"
                          fill="currentColor"
                          viewBox="0 0 20 20"
                        >
                          <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                        </svg>
                        {overrideCount} Manual Edits
                      </div>
                    )}
                    {violationCount > 0 && (
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-red-700 bg-red-100 border border-red-300 px-3 py-1 rounded-lg">
                        <svg
                          className="w-3.5 h-3.5"
                          fill="currentColor"
                          viewBox="0 0 20 20"
                        >
                          <path
                            fillRule="evenodd"
                            d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                            clipRule="evenodd"
                          />
                        </svg>
                        {violationCount} Violations
                      </div>
                    )}
                    <div className="flex items-center gap-3 text-xs bg-white border-2 border-gray-300 rounded-lg px-4 py-1.5">
                      <div className="text-right">
                        <div className="text-gray-500 text-[10px]">Total</div>
                        <div className="font-bold text-[#006DAE]">
                          {totalVol.toFixed(1)} MW
                        </div>
                      </div>
                      <div className="w-px h-6 bg-gray-300"></div>
                      <div className="text-right">
                        <div className="text-gray-500 text-[10px]">
                          Avg Price
                        </div>
                        <div className="font-bold text-[#006DAE]">
                          ₹{avgBidPrice.toFixed(3)}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Scrollable table */}
              <div className="overflow-y-auto max-h-[480px]">
                <table className="w-full text-xs border-collapse">
                  <thead className="sticky top-0 z-10 bg-gray-50 border-b border-gray-200">
                    <tr className="text-[10px] text-gray-500 uppercase tracking-wider">
                      <th className="text-left py-2 px-3 font-medium">#</th>
                      <th className="text-left py-2 px-2 font-medium">Time</th>
                      <th className="text-right py-2 px-2 font-medium">
                        Fcst ₹
                      </th>
                      <th className="text-right py-2 px-2 font-medium">
                        CI Band
                      </th>
                      <th className="text-right py-2 px-2 font-medium text-[#006DAE]">
                        Bid ₹
                      </th>
                      <th className="text-right py-2 px-2 font-medium text-[#006DAE]">
                        Vol MW
                      </th>
                      <th className="text-right py-2 px-2 font-medium">
                        DSM Est
                      </th>
                      <th className="text-right py-2 px-2 font-medium">
                        Uncert.
                      </th>
                      <th className="text-center py-2 px-2 font-medium">
                        Status
                      </th>
                      <th className="text-left py-2 px-2 font-medium">
                        Reason
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {bidRows.map((b, idx) => {
                      const hasViolation = b.constraint_violations?.length > 0;
                      const isEdited = b.is_overridden;
                      const ciWidth = b.confidence_high - b.confidence_low;
                      const highUncertainty = ciWidth > 0.5;

                      return (
                        <tr
                          key={b.block}
                          className={`border-t border-gray-100 transition-colors ${
                            hasViolation
                              ? "bg-red-50"
                              : isEdited
                                ? "bg-amber-50"
                                : idx % 2 === 0
                                  ? "bg-transparent"
                                  : "bg-gray-50/60"
                          } hover:bg-blue-50/40`}
                        >
                          {/* Block # */}
                          <td className="py-1.5 px-3 font-mono font-medium text-gray-500">
                            {b.block}
                          </td>

                          {/* Time */}
                          <td className="py-1.5 px-2 text-gray-500 tabular-nums">
                            {blockToTime(b.block)}
                          </td>

                          {/* Forecast price */}
                          <td className="py-1.5 px-2 text-right tabular-nums text-gray-700">
                            {b.predicted_price.toFixed(3)}
                          </td>

                          {/* CI Band */}
                          <td className="py-1.5 px-2 text-right tabular-nums">
                            <span
                              className={`text-[10px] ${
                                highUncertainty
                                  ? "text-amber-600"
                                  : "text-gray-400"
                              }`}
                            >
                              {b.confidence_low.toFixed(2)}-
                              {b.confidence_high.toFixed(2)}
                            </span>
                          </td>

                          {/* Bid price (editable until submission) */}
                          <td className="py-1 px-2 text-right">
                            <input
                              type="number"
                              step="0.001"
                              value={b.price}
                              readOnly={submitted}
                              aria-label={`Bid price for block ${b.block}`}
                              onChange={(e) =>
                                handleCellEdit(b.block, "price", e.target.value)
                              }
                              className={`w-20 bg-transparent border-b tabular-nums text-right text-xs focus:outline-none transition-colors ${
                                hasViolation
                                  ? "border-red-400 text-red-700 focus:border-red-500"
                                  : isEdited
                                    ? "border-amber-400 text-amber-700 focus:border-amber-500"
                                    : "border-gray-300 text-gray-900 focus:border-[#006DAE]"
                              }`}
                            />
                          </td>

                          {/* Volume (editable until submission) */}
                          <td className="py-1 px-2 text-right">
                            <input
                              type="number"
                              step="0.1"
                              value={b.volume_mw}
                              readOnly={submitted}
                              aria-label={`Volume for block ${b.block}`}
                              onChange={(e) =>
                                handleCellEdit(
                                  b.block,
                                  "volume_mw",
                                  e.target.value,
                                )
                              }
                              className={`w-16 bg-transparent border-b tabular-nums text-right text-xs focus:outline-none transition-colors ${
                                isEdited
                                  ? "border-amber-400 text-amber-700 focus:border-amber-500"
                                  : "border-gray-300 text-gray-900 focus:border-[#006DAE]"
                              }`}
                            />
                          </td>

                          {/* DSM estimate */}
                          <td className="py-1.5 px-2 text-right tabular-nums">
                            <span
                              className={`text-[10px] ${
                                b.dsm_penalty_estimate > 0
                                  ? "text-red-600"
                                  : "text-gray-400"
                              }`}
                            >
                              {b.dsm_penalty_estimate > 0
                                ? formatINR(b.dsm_penalty_estimate)
                                : "-"}
                            </span>
                          </td>

                          {/* Uncertainty */}
                          <td className="py-1.5 px-2 text-right tabular-nums">
                            <span
                              className={`text-[10px] ${
                                highUncertainty
                                  ? "text-amber-600"
                                  : "text-gray-400"
                              }`}
                            >
                              {b.uncertainty_score.toFixed(3)}
                            </span>
                          </td>

                          {/* Status badge */}
                          <td className="py-1.5 px-2 text-center">
                            {hasViolation ? (
                              <span
                                className="badge-violation cursor-help"
                                title={b.constraint_violations
                                  .map((v) => v.message)
                                  .join("; ")}
                              >
                                ⚠
                              </span>
                            ) : isEdited ? (
                              <span className="badge-warning">Edited</span>
                            ) : (
                              <span className="badge-ok">Model</span>
                            )}
                          </td>

                          {/* Override reason */}
                          <td className="py-1 px-2">
                            {isEdited && (
                              <>
                                {editingReasonBlock === b.block ? (
                                  <select
                                    className="select-field text-[10px] py-0.5 w-32"
                                    value={b.override_reason}
                                    onChange={(e) => {
                                      const reason = e.target.value;
                                      setBidRows((prev) =>
                                        prev.map((row) =>
                                          row.block === b.block
                                            ? {
                                                ...row,
                                                override_reason: reason,
                                              }
                                            : row,
                                        ),
                                      );
                                      setEditingReasonBlock(null);
                                    }}
                                    autoFocus
                                    onBlur={() => setEditingReasonBlock(null)}
                                  >
                                    <option value="">Select…</option>
                                    {OVERRIDE_REASONS.map((r) => (
                                      <option key={r} value={r}>
                                        {r}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <button
                                    onClick={() =>
                                      setEditingReasonBlock(b.block)
                                    }
                                    disabled={submitted}
                                    className="text-[10px] text-amber-600 enabled:hover:underline disabled:text-gray-400 text-left max-w-[100px] truncate"
                                  >
                                    {b.override_reason || "Add reason…"}
                                  </button>
                                )}
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Empty states */}
          {bidRows.length === 0 && forecastBlocks.length === 0 && (
            <div className="card flex flex-col items-center justify-center py-16 gap-2 text-center">
              <p className="text-gray-600 text-sm font-medium">
                No forecast for this delivery date yet
              </p>
              <p className="text-gray-400 text-xs max-w-md">
                Choose a delivery date, segment and strategy, then click{" "}
                <span className="text-[#006DAE] font-medium whitespace-nowrap">
                  Generate Forecast
                </span>
                .
              </p>
            </div>
          )}

          {forecastBlocks.length > 0 && bidRows.length === 0 && (
            <div className="card flex flex-col items-center justify-center py-10 gap-2 text-center">
              <p className="text-gray-500 text-sm">
                Forecast ready. Click{" "}
                <span className="text-[#006DAE] font-medium">Optimize Bids</span>{" "}
                to build the bid schedule.
              </p>
            </div>
          )}
        </div>

        {/* ── Right panel: Risk ───────────────────────────────────────── */}
        <div className="w-72 shrink-0 flex flex-col gap-3 sticky top-4">
          {/* Risk metrics card */}
          <div className="card">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-semibold text-gray-700">Risk</h3>
              {riskLoading && (
                <span className="text-[10px] text-gray-600 flex items-center gap-1.5 bg-gray-100 border border-gray-300 px-2 py-1 rounded-full">
                  <Spinner className="w-3 h-3" />
                  Updating…
                </span>
              )}
            </div>

            {liveRisk ? (
              <div className="flex flex-col gap-3">
                {liveRisk.alert_triggered && (
                  <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2">
                    <p className="text-red-600 text-[10px] font-bold uppercase tracking-wider">
                      ⚠ Risk Alert
                    </p>
                    <p className="text-red-600 text-[10px] mt-0.5">
                      {liveRisk.alert_details?.message ??
                        "Exposure exceeds threshold"}
                    </p>
                  </div>
                )}
                {liveRisk.forecast_coverage < bidRows.length && (
                  <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-amber-700 text-[10px]">
                    Forecast covers {liveRisk.forecast_coverage} of{" "}
                    {bidRows.length} blocks. Exposure for the rest is not
                    included.
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <RiskMetric
                    label="VaR 95%"
                    value={formatINR(liveRisk.var_95)}
                    color="#006DAE"
                    sub="parametric"
                  />
                  <RiskMetric
                    label="Exp. DSM"
                    value={formatINR(liveRisk.expected_dsm_penalty)}
                    color={
                      liveRisk.expected_dsm_penalty > 10000
                        ? "#ef4444"
                        : "#00B398"
                    }
                    sub="drawal uncertainty"
                  />
                  <RiskMetric
                    label="Worst DSM"
                    value={formatINR(liveRisk.worst_case_penalty)}
                    color="#f59e0b"
                    sub="30% stress"
                  />
                  <RiskMetric
                    label="Total Exp."
                    value={formatINR(liveRisk.total_exposure)}
                    color={liveRisk.alert_triggered ? "#ef4444" : "#00B398"}
                    sub={
                      liveRisk.alert_triggered
                        ? "above threshold"
                        : "within limit"
                    }
                  />
                </div>

                <div className="pt-2 border-t border-[var(--border)]">
                  <div className="flex justify-between text-[10px] text-gray-500 mb-1">
                    <span>
                      Exposure vs {formatINR(liveRisk.var_threshold)} limit
                    </span>
                    <span
                      className={`tabular-nums ${
                        liveRisk.alert_triggered
                          ? "text-red-600"
                          : "text-teal-600"
                      }`}
                    >
                      {exposurePct.toFixed(0)}%
                    </span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-1.5">
                    <div
                      className={`h-1.5 rounded-full transition-all ${
                        liveRisk.alert_triggered ? "bg-red-500" : "bg-[#00B398]"
                      }`}
                      style={{ width: `${Math.min(exposurePct, 100)}%` }}
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div className="py-10 text-center bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
                <div className="w-12 h-12 rounded-full bg-gray-200 mx-auto mb-3 flex items-center justify-center">
                  <svg
                    className="w-6 h-6 text-gray-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                    />
                  </svg>
                </div>
                <p className="text-xs font-medium text-gray-600">
                  {bidRows.length === 0 ? "No bids yet" : "Calculating risk…"}
                </p>
                <p className="text-[10px] text-gray-500 mt-1">
                  {bidRows.length === 0
                    ? "Risk metrics appear once bids are optimized"
                    : "Updates automatically as you edit bids"}
                </p>
              </div>
            )}
          </div>

          {/* Optimizer summary */}
          {bidRows.length > 0 && (
            <div className="card">
              <h3 className="text-xs font-semibold text-gray-700 mb-3">
                Optimizer Summary
              </h3>
              <div className="space-y-1.5 text-[11px]">
                <div className="flex justify-between">
                  <span className="text-gray-500">Total volume</span>
                  <span className="text-gray-900 font-medium tabular-nums">
                    {totalVol.toFixed(1)} MW
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Avg bid price</span>
                  <span className="text-gray-900 font-medium tabular-nums">
                    ₹{avgBidPrice.toFixed(3)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span
                    className="text-gray-500"
                    title="DSM charge if cleared volume differs from the per-block demand"
                  >
                    DSM on demand gap
                  </span>
                  <span
                    className={`font-medium tabular-nums ${
                      totalDsmEst > 0 ? "text-red-600" : "text-teal-600"
                    }`}
                  >
                    {formatINR(totalDsmEst)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Overrides</span>
                  <span
                    className={`tabular-nums ${
                      overrideCount > 0
                        ? "text-amber-600 font-medium"
                        : "text-gray-400"
                    }`}
                  >
                    {overrideCount} / {bidRows.length}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Violations</span>
                  <span
                    className={`font-medium tabular-nums ${
                      violationCount > 0 ? "text-red-600" : "text-teal-600"
                    }`}
                  >
                    {violationCount}
                  </span>
                </div>
                <div className="flex justify-between pt-1.5 border-t border-gray-100">
                  <span className="text-gray-400">λ₁ applied</span>
                  <span
                    className={`font-mono text-[10px] font-medium ${lambda1 !== null ? "text-[#006DAE]" : "text-gray-400"}`}
                  >
                    {appliedLambda1.toFixed(3)}
                    {lambda1 !== null ? " ✎" : ""}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">λ₂ applied</span>
                  <span
                    className={`font-mono text-[10px] font-medium ${lambda2 !== null ? "text-[#006DAE]" : "text-gray-400"}`}
                  >
                    {appliedLambda2.toFixed(3)}
                    {lambda2 !== null ? " ✎" : ""}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Strategy λ info */}
          <div className="card">
            <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
              LP Objective
            </span>
            <div className="mt-2 font-mono text-[10px] text-gray-500 leading-relaxed">
              <div>max Σ price[b]·vol[b]</div>
              <div className="text-[9px] mt-0.5">
                <span style={{ color: stratMeta.color }}>
                  − λ₁·DSM_penalty[b]
                </span>
              </div>
              <div className="text-[9px]">
                <span style={{ color: stratMeta.color }}>
                  − λ₂·CI_width[b]·vol[b]
                </span>
              </div>
              <div className="mt-2 text-[9px] space-y-0.5">
                <div className="flex justify-between">
                  <span>λ₁ (DSM weight)</span>
                  <span style={{ color: stratMeta.color }}>
                    {effectiveLambda1.toFixed(2)}
                    {lambda1 !== null && (
                      <span className="ml-1 text-[8px] text-[#006DAE]">✎</span>
                    )}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>λ₂ (Uncertainty weight)</span>
                  <span style={{ color: stratMeta.color }}>
                    {effectiveLambda2.toFixed(2)}
                    {lambda2 !== null && (
                      <span className="ml-1 text-[8px] text-[#006DAE]">✎</span>
                    )}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
