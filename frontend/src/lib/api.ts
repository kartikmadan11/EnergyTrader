import axios from "axios";
import { SIGNED_OUT } from "@/lib/access";

// Requests go through the web app's proxy, which adds the signed-in user's token.
const api = axios.create({
  baseURL: "/api",
  headers: { "Content-Type": "application/json" },
});

// When the session ends, send the user to sign in and back to the page they were on.
// A 401 from the API itself means its token was refused, so it surfaces as an error instead
// of looping through sign-in.
api.interceptors.response.use(undefined, (error) => {
  if (error?.response?.status === 401 && error.response.data?.reason === SIGNED_OUT) {
    // A full page load, so no state from the ended session survives.
    const login = new URL("/login", window.location.origin);
    login.searchParams.set("callbackUrl", `${window.location.pathname}${window.location.search}`);
    window.location.assign(login);
  }
  return Promise.reject(error);
});

/**
 * Human-readable message for a failed request.
 *
 * FastAPI returns `detail` as a string, a Pydantic validation array of
 * `{loc, msg}` objects, or (for blocked submissions) an object with `message`.
 */
export function errorMessage(e: unknown, fallback: string): string {
  const detail = (e as { response?: { data?: { detail?: unknown } } })?.response
    ?.data?.detail;
  if (!detail) return fallback;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail))
    return detail
      .map(
        (d: { loc?: (string | number)[]; msg?: string }) =>
          `${d.loc?.slice(-1)[0] ?? "field"}: ${d.msg}`,
      )
      .join(" · ");
  if (typeof detail === "object" && "message" in detail)
    return String((detail as { message: unknown }).message);
  return fallback;
}

// ---- Forecast ----
export type TuneMethod = "grid" | "random";
export type TuneScoring =
  | "neg_mean_absolute_percentage_error"
  | "neg_mean_squared_error"
  | "r2";

export interface TrainConfig {
  segment: string;
  test_size?: number;
  shuffle?: boolean;
  max_days?: number | null;
  hyperparams?: {
    max_iter?: number;
    max_depth?: number | null;
    learning_rate?: number;
    min_samples_leaf?: number;
    l2_regularization?: number;
    max_bins?: number;
    max_leaf_nodes?: number | null;
    early_stopping?: boolean;
    n_iter_no_change?: number;
    validation_fraction?: number;
  };
  tuning?: {
    method?: TuneMethod;
    n_iter?: number;
    cv_folds?: number;
    scoring?: TuneScoring;
    param_grid?: Record<string, unknown[]> | null;
  } | null;
  features?: {
    extra_lags?: number[];
    rolling_windows?: number[];
    include_demand_supply_ratio?: boolean;
    include_price_momentum?: boolean;
    include_ema?: boolean;
    ema_span?: number;
    include_weather?: boolean;
    include_holidays?: boolean;
    include_month_cyclic?: boolean;
    include_price_range?: boolean;
    include_summer_signal?: boolean;
  };
}

export interface TrainMetrics {
  /** Null when every test price is below the ₹1/kWh MAPE floor. */
  mape: number | null;
  smape: number;
  rmse: number;
  mae: number;
  r2: number;
  train_size: number;
  test_size: number;
  n_features: number;
  feature_names: string[];
  top_features: { feature: string; importance: number }[];
  block_smape_worst_5: Record<string, number>;
  best_params?: Record<string, unknown>;
  cv_results?: unknown;
}

export interface TrainResult {
  status: "trained";
  segment: string;
  metrics: TrainMetrics;
}

export async function trainModel(config: TrainConfig): Promise<TrainResult> {
  const res = await api.post("/forecast/train", config);
  return res.data;
}

export interface ForecastBlock {
  block: number;
  predicted_price: number;
  confidence_low: number;
  confidence_high: number;
  volatility: number;
  top_features: { feature: string; importance: number }[];
}

export interface ForecastResponse {
  target_date: string;
  segment: string;
  blocks: ForecastBlock[];
}

export async function predictPrices(
  targetDate: string,
  segment: string,
  blockStart = 1,
  blockEnd = 96,
): Promise<ForecastResponse> {
  const res = await api.get("/forecast/predict", {
    params: {
      target_date: targetDate,
      segment,
      block_start: blockStart,
      block_end: blockEnd,
    },
  });
  return res.data;
}

// ---- Bids ----
/** One block of a bid set as accepted by validate, risk, approval and submit. */
export interface BidItem {
  block: number;
  segment: string;
  price: number;
  volume_mw: number;
  is_overridden?: boolean;
  override_reason?: string;
}

export interface ConstraintViolation {
  block: number;
  field: string;
  value: number;
  limit: number;
  message: string;
}

export interface BidRecommendation {
  block: number;
  segment: string;
  price: number;
  volume_mw: number;
  strategy: string;
  dsm_penalty_estimate: number;
  uncertainty_score: number;
  constraint_violations: ConstraintViolation[];
  active_policy: string;
  effective_lambda1: number;
  effective_lambda2: number;
}

export interface BidOptConfig {
  price_offset?: number | null;
  risk_tolerance?: number | null;
  volume_scale?: number | null;
  per_block_cap_factor?: number;
  lambda1_base?: number | null;
  lambda2_base?: number | null;
}

export async function recommendBids(
  targetDate: string,
  strategy: string,
  segment: string,
  demandMw: number = 500,
  overrides: BidOptConfig = {},
): Promise<BidRecommendation[]> {
  const res = await api.get("/bids/recommend", {
    params: {
      target_date: targetDate,
      strategy,
      segment,
      demand_mw: demandMw,
      ...(overrides.price_offset != null && {
        price_offset: overrides.price_offset,
      }),
      ...(overrides.risk_tolerance != null && {
        risk_tolerance: overrides.risk_tolerance,
      }),
      ...(overrides.volume_scale != null && {
        volume_scale: overrides.volume_scale,
      }),
      ...(overrides.per_block_cap_factor != null && {
        per_block_cap_factor: overrides.per_block_cap_factor,
      }),
      ...(overrides.lambda1_base != null && {
        lambda1_base: overrides.lambda1_base,
      }),
      ...(overrides.lambda2_base != null && {
        lambda2_base: overrides.lambda2_base,
      }),
    },
  });
  return res.data;
}

export interface SubmitResult {
  session_id: string;
  target_date: string;
  segment: string;
  bid_count: number;
  verdict: ApprovalResult["verdict"];
  score: number;
  status: "submitted";
}

/** Submit a bid set. The server re-runs the pre-trade checks and returns 422 if they block it. */
export async function submitBids(
  targetDate: string,
  strategy: string,
  segment: string,
  bids: BidItem[],
): Promise<SubmitResult> {
  const res = await api.post("/bids/submit", bids, {
    params: { target_date: targetDate, strategy, segment },
  });
  return res.data;
}

export interface TuneResult {
  best_lambda1_base: number;
  best_lambda2_base: number;
  /** Total bid value minus twice the estimated DSM penalty, in INR. */
  best_score: number;
  grid: {
    lambda1_base: number;
    lambda2_base: number;
    total_bid_value: number;
    total_dsm_penalty: number;
    score: number;
  }[];
}

export async function autoTuneLambdas(
  targetDate: string,
  strategy: string,
  segment: string,
  demandMw: number = 500,
): Promise<TuneResult> {
  const res = await api.get("/bids/tune", {
    params: { target_date: targetDate, strategy, segment, demand_mw: demandMw },
  });
  return res.data;
}

export interface ValidationResult {
  valid: boolean;
  violation_count: number;
  violations: ConstraintViolation[];
}

/** Check bids against the active policy's price band and technical minimum. */
export async function validateBids(bids: BidItem[]): Promise<ValidationResult> {
  const res = await api.post("/bids/validate", bids);
  return res.data;
}

// ---- Approval ----
export interface ApprovalCheck {
  name: string;
  category: "hard" | "soft";
  status: "pass" | "warn" | "fail";
  message: string;
  affected_blocks: number[];
}

export interface ApprovalResult {
  session_id: string;
  target_date: string;
  segment: string;
  strategy: string;
  verdict: "APPROVED" | "APPROVED_WITH_FLAGS" | "NEEDS_REVISION" | "REJECTED";
  score: number;
  checks: ApprovalCheck[];
  summary: string;
  can_submit: boolean;
}

export async function requestApproval(
  sessionId: string,
  targetDate: string,
  segment: string,
  strategy: string,
  bids: BidItem[],
): Promise<ApprovalResult> {
  const res = await api.post("/bids/request-approval", bids, {
    params: {
      session_id: sessionId,
      target_date: targetDate,
      segment,
      strategy,
    },
  });
  return res.data;
}

// ---- Risk ----
export interface RiskResult {
  segment: string;
  var_95: number;
  expected_dsm_penalty: number;
  worst_case_penalty: number;
  total_exposure: number;
  alert_triggered: boolean;
  alert_details: { message: string; [key: string]: unknown } | null;
  var_threshold: number;
  /** Bids that had a stored forecast for their block. */
  forecast_coverage: number;
  policy_id: string;
}

export async function assessRisk(
  sessionId: string,
  targetDate: string,
  segment: string,
  bids: BidItem[],
  varThreshold?: number,
): Promise<RiskResult> {
  const params: Record<string, unknown> = {
    session_id: sessionId,
    target_date: targetDate,
    segment,
  };
  if (varThreshold !== undefined) params.var_threshold = varThreshold;
  const res = await api.post("/risk/assess", bids, { params });
  return res.data;
}

// ---- Audit ----
export interface AuditEntry {
  id: number;
  timestamp: string | null;
  session_id: string | null;
  user: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  details: Record<string, unknown> | null;
}

export async function getAuditLog(
  sessionId?: string,
  limit: number = 100,
): Promise<AuditEntry[]> {
  const params: Record<string, unknown> = { limit };
  if (sessionId) params.session_id = sessionId;
  const res = await api.get("/audit/log", { params });
  return res.data;
}

export interface PostMarketBlock {
  block: number;
  predicted_price: number | null;
  actual_price: number;
  bid_price: number | null;
  bid_volume: number | null;
  cleared: boolean;
  error: number | null;
  error_pct: number | null;
}

export interface PostMarketSummary {
  target_date: string;
  segment: string;
  /** Submitted bid session that was analyzed, if any. */
  session_id: string | null;
  blocks: PostMarketBlock[];
  /** MAPE over blocks priced at or above the metrics floor; null when none qualify. */
  mape: number | null;
  /** MAE over blocks with a stored forecast; null when there are none. */
  mae: number | null;
  bid_hit_rate: number;
  basket_rate: number;
  baseline_basket_rate: number;
  basket_rate_change_pct: number;
  uncleared_dsm_exposure: number;
}

export async function postMarketAnalysis(
  targetDate: string,
  segment: string,
  sessionId?: string,
): Promise<PostMarketSummary> {
  const params: Record<string, unknown> = { target_date: targetDate, segment };
  if (sessionId) params.session_id = sessionId;
  const res = await api.get("/audit/post-market", { params });
  return res.data;
}

// ---- Health / Fallback ----
/** API liveness probe. */
export async function pingApi(): Promise<boolean> {
  try {
    const res = await api.get("/health", { timeout: 5000 });
    return res.data?.status === "ok";
  } catch {
    return false;
  }
}

export interface SegmentHealth {
  latest_data: string | null;
  row_count: number;
  latest_forecast: string | null;
}

export interface DataHealth {
  status: "ok";
  segments: Record<"DAM" | "RTM" | "TAM", SegmentHealth>;
}

/** Per-segment data freshness. */
export async function getHealth(): Promise<DataHealth> {
  const res = await api.get("/forecast/health");
  return res.data;
}

export async function getLatestForecast(segment: string): Promise<ForecastResponse> {
  const res = await api.get("/forecast/latest", { params: { segment } });
  return res.data;
}

export async function getHistory(segment: string, days: number = 7) {
  const res = await api.get("/forecast/history", { params: { segment, days } });
  return res.data as { date: string; block: number; mcp: number }[];
}

export async function getDataCoverage(segment: string) {
  const res = await api.get("/forecast/data-coverage", { params: { segment } });
  return res.data as { segment: string; dates: string[] };
}

export interface BacktestBlock {
  block: number;
  predicted: number;
  actual: number;
  /** Absolute percentage error; null when the actual price is below the MAPE floor. */
  error_pct: number | null;
}

export interface BacktestDay {
  date: string;
  /** Where the date sat relative to the model's training data. */
  data_split: "train" | "test" | "unseen";
  mape: number | null;
  smape: number;
  mae: number;
  rmse: number;
  avg_predicted: number;
  avg_actual: number;
  blocks: BacktestBlock[];
}

export interface BacktestResult {
  segment: string;
  start_date: string;
  end_date: string;
  days_evaluated: number;
  aggregate: { mape: number | null; smape: number; mae: number; rmse: number; r2: number };
  best_day: { date: string; mape: number | null; smape: number };
  worst_day: { date: string; mape: number | null; smape: number };
  daily: BacktestDay[];
}

/** Walk-forward backtest: each date is forecast from history before it only. */
export async function evaluateForecast(
  startDate: string,
  endDate: string,
  segment: string,
): Promise<BacktestResult> {
  const res = await api.get("/forecast/evaluate", {
    params: { start_date: startDate, end_date: endDate, segment },
  });
  return res.data;
}

/** Scrape one segment for an inclusive date range of up to 30 days. */
export async function triggerScrape(segment: string, startDate: string, endDate: string) {
  const res = await api.post("/scraper/trigger", null, {
    params: { segment, start_date: startDate, end_date: endDate },
  });
  return res.data as {
    status: string;
    segment: string;
    start_date: string;
    end_date: string;
    scraped: number;
    inserted: number;
    dates_with_data: string[];
    errors: string[];
  };
}

// ---- DSM Policy ----
/** Window event fired after a policy is activated or edited, so other views can refresh. */
export const POLICY_CHANGED_EVENT = "energytrader:policy-changed";

export interface DSMPolicy {
  regulation_id: string;
  name: string;
  description: string;
  effective_date: string;
  status: string;
  price_floor: number;
  price_ceiling: number;
  deviation_band: number;
  penalty_rate: number;
  severe_deviation_threshold: number;
  severe_penalty_multiplier: number;
  technical_minimum_mw: number;

  is_active?: boolean;
}

export interface PolicyDiff {
  field: string;
  policy_a_value: number;
  policy_b_value: number;
  pct_change: number | null;
  direction: "stricter" | "looser";
}

export interface PolicyComparison {
  policy_a: DSMPolicy;
  policy_b: DSMPolicy;
  diffs: PolicyDiff[];
  summary: string;
}

export async function listPolicies(): Promise<DSMPolicy[]> {
  const res = await api.get("/policy/list");
  return res.data;
}

export async function getActivePolicy(): Promise<DSMPolicy> {
  const res = await api.get("/policy/active");
  return res.data;
}

export async function activatePolicy(
  regulationId: string,
): Promise<{ message: string; policy: DSMPolicy }> {
  const res = await api.post(`/policy/activate/${regulationId}`);
  return res.data;
}

export async function comparePolicies(
  policyA: string,
  policyB: string,
): Promise<PolicyComparison> {
  const res = await api.get("/policy/compare", {
    params: { policy_a: policyA, policy_b: policyB },
  });
  return res.data;
}

export async function updatePolicy(
  regulationId: string,
  updates: Partial<Omit<DSMPolicy, "regulation_id" | "is_active">>,
): Promise<{ message: string; policy: DSMPolicy }> {
  const res = await api.put(`/policy/${regulationId}`, updates);
  return res.data;
}

// ---- Enrichment (weather + holidays) ----
export interface EnrichStatus {
  /** Price history rows still missing weather features. */
  unenriched_rows: number;
  date_range: { earliest: string | null; latest: string | null };
}

export async function getEnrichStatus(): Promise<EnrichStatus> {
  const res = await api.get("/scraper/enrich/status");
  return res.data;
}

/** Start weather enrichment in the background; poll `getEnrichStatus` for progress. */
export async function triggerEnrich(params?: {
  start_date?: string;
  end_date?: string;
  overwrite?: boolean;
}) {
  const res = await api.post("/scraper/enrich", null, { params });
  return res.data as {
    status: "started";
    params: { start_date: string | null; end_date: string | null; overwrite: boolean };
  };
}

export default api;
