"""
Price Forecasting Engine using HistGradientBoostingRegressor.
Produces block-level predictions for 96 blocks with confidence intervals.
Supports parameterised training with hyperparameter tuning.
"""

import pickle

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.inspection import permutation_importance
from sklearn.metrics import r2_score
from sklearn.model_selection import (
    GridSearchCV,
    RandomizedSearchCV,
    TimeSeriesSplit,
    train_test_split,
)

from common.config import DATA_DIR, NUM_BLOCKS

from . import metrics

MODEL_DIR = DATA_DIR / "models"
MODEL_DIR.mkdir(parents=True, exist_ok=True)


def _serialise(v):
    """Make numpy/other types JSON-friendly."""
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating,)):
        return float(v)
    if isinstance(v, np.ndarray):
        return v.tolist()
    return v


# Base feature names (always present)
BASE_FEATURE_NAMES = [
    "hour",
    "block_in_hour",
    "day_of_week",
    "month",
    "is_weekend",
    "lag_demand_1d",
    "lag_supply_1d",
    "lag_renewable_1d",
    "temperature",
    "lag_price_1d",
    "lag_price_7d",
    "rolling_avg_7d",
    "rolling_std_7d",
    "block_sin",
    "block_cos",
]

# Hourly weather features (added when trained with include_weather)
WEATHER_FEATURE_NAMES = ("wind_speed_ms", "solar_radiation_wm2", "cloud_cover_pct")

# Default tuning search space
DEFAULT_PARAM_GRID = {
    "max_iter": [200, 300, 500, 800, 1200],
    "max_depth": [4, 6, 8, 10, 12, None],
    "learning_rate": [0.01, 0.03, 0.05, 0.08, 0.1, 0.15],
    "min_samples_leaf": [5, 10, 20, 30, 50],
    "l2_regularization": [0.0, 0.01, 0.1, 1.0],
    "max_bins": [128, 200, 255],
}


class PriceForecastModel:
    def __init__(self, segment: str = "DAM"):
        self.segment = segment
        self.model = None
        self.feature_importances = None
        self.feature_names: list[str] = []
        self.model_path = MODEL_DIR / f"forecast_{segment.lower()}.pkl"

    def _build_features(
        self,
        df: pd.DataFrame,
        extra_lags: list | None = None,
        rolling_windows: list | None = None,
        include_demand_supply_ratio: bool = True,
        include_price_momentum: bool = True,
        include_ema: bool = True,
        ema_span: int = 7,
        include_weather: bool = True,
        include_holidays: bool = True,
        include_month_cyclic: bool = True,
        include_price_range: bool = True,
        include_summer_signal: bool = True,
    ) -> tuple[pd.DataFrame, list[str]]:
        """Engineer features from raw price history. Returns (df, feature_names)."""
        df = df.sort_values(["date", "block"]).copy()
        df["datetime"] = pd.to_datetime(df["date"])
        df["hour"] = (df["block"] - 1) // 4
        df["block_in_hour"] = (df["block"] - 1) % 4
        df["day_of_week"] = df["datetime"].dt.dayofweek
        df["month"] = df["datetime"].dt.month
        df["is_weekend"] = (df["day_of_week"] >= 5).astype(int)

        # Cyclic encoding of block position
        df["block_sin"] = np.sin(2 * np.pi * df["block"] / NUM_BLOCKS)
        df["block_cos"] = np.cos(2 * np.pi * df["block"] / NUM_BLOCKS)

        # Standard lag features
        df["lag_price_1d"] = df.groupby("block")["mcp"].shift(1)
        df["lag_price_7d"] = df.groupby("block")["mcp"].shift(7)

        # Lag demand/supply/renewable - closes train/predict mismatch.
        # At prediction time we only know T-1 grid conditions; training must use the
        # same shifted values so the model sees what will actually be available.
        for _raw, _lag in [
            ("demand_mw", "lag_demand_1d"),
            ("supply_mw", "lag_supply_1d"),
            ("renewable_gen_mw", "lag_renewable_1d"),
        ]:
            if _raw in df.columns:
                df[_lag] = df.groupby("block")[_raw].shift(1)
            else:
                df[_lag] = 0.0

        feature_names = list(BASE_FEATURE_NAMES)
        drop_subset = ["lag_price_1d"]

        # Extra lag features
        if extra_lags:
            for lag in extra_lags:
                col = f"lag_price_{lag}d"
                df[col] = df.groupby("block")["mcp"].shift(lag)
                feature_names.append(col)
                drop_subset.append(col)

        # Rolling statistics for each window.
        # IMPORTANT: shift(1) before rolling so that rolling_avg_7d[T] =
        # mean(T-7...T-1) and never includes today's price (no leakage).
        if rolling_windows is None:
            rolling_windows = [7]
        for w in rolling_windows:
            avg_col = f"rolling_avg_{w}d"
            std_col = f"rolling_std_{w}d"
            df[avg_col] = df.groupby("block")["mcp"].transform(
                lambda x, w=w: x.shift(1).rolling(w, min_periods=1).mean()
            )
            df[std_col] = df.groupby("block")["mcp"].transform(
                lambda x, w=w: x.shift(1).rolling(w, min_periods=1).std().fillna(0)
            )
            # Only add if not already in base features
            if avg_col not in feature_names:
                feature_names.append(avg_col)
            if std_col not in feature_names:
                feature_names.append(std_col)

        # Rolling median (also shifted for consistency)
        for w in rolling_windows:
            med_col = f"rolling_median_{w}d"
            df[med_col] = df.groupby("block")["mcp"].transform(
                lambda x, w=w: x.shift(1).rolling(w, min_periods=1).median()
            )
            feature_names.append(med_col)

        # Demand/supply ratio - use lagged values (T-1) to match prediction time
        if include_demand_supply_ratio:
            df["demand_supply_ratio"] = df["lag_demand_1d"] / df["lag_supply_1d"].clip(lower=1)
            feature_names.append("demand_supply_ratio")

        # Price momentum (rate of change) - shifted by 1 to prevent data leakage.
        # At prediction time we pass yesterday's momentum; training must match.
        if include_price_momentum:
            df["price_momentum"] = (
                df.groupby("block")["mcp"].pct_change(periods=1).shift(1).fillna(0)
            )
            feature_names.append("price_momentum")

        # Exponential moving average - shifted by 1 to prevent data leakage.
        # Without shift, ema[t] = 0.25 × price[t] + 0.75 × ema[t-1], which embeds
        # today's price in the feature and causes train/predict mismatch.
        if include_ema:
            df["ema_price"] = df.groupby("block")["mcp"].transform(
                lambda x: x.ewm(span=ema_span, min_periods=1).mean().shift(1)
            )
            df["ema_price"] = df["ema_price"].fillna(df.groupby("block")["mcp"].transform("mean"))
            feature_names.append("ema_price")

        # Same-day-of-week rolling average (4-week window, no leakage via shift)
        # Captures weekly seasonality: e.g. Sunday prices differ from Monday prices.
        # Groups by (block, day_of_week) so each weekday has its own anchor.
        df["same_dow_avg_4w"] = df.groupby(["block", "day_of_week"])["mcp"].transform(
            lambda x: x.shift(1).rolling(4, min_periods=1).mean()
        )
        df["same_dow_avg_4w"] = df["same_dow_avg_4w"].fillna(df["ema_price"])
        feature_names.append("same_dow_avg_4w")

        # Fill missing numeric columns
        for col in ["demand_mw", "supply_mw", "renewable_gen_mw", "temperature"]:
            if col not in df.columns:
                df[col] = 0.0
            df[col] = df[col].fillna(
                df[col].median() if df[col].median() == df[col].median() else 0
            )

        # ── Weather features (toggled by include_weather) ──────────────────
        if include_weather:
            for col in WEATHER_FEATURE_NAMES:
                if col not in df.columns:
                    df[col] = np.nan
                feature_names.append(col)

        # ── Holiday features (toggled by include_holidays) ─────────────────
        if include_holidays:
            try:
                from data.enrich_pipeline import compute_holiday_features

                df["is_holiday"], df["days_to_holiday"] = compute_holiday_features(df["datetime"])
                feature_names += ["is_holiday", "days_to_holiday"]
            except Exception:
                pass  # enrich_pipeline unavailable - skip silently

        # ── Month cyclic encoding (toggled by include_month_cyclic) ────────
        if include_month_cyclic:
            df["month_sin"] = np.sin(2 * np.pi * df["month"] / 12)
            df["month_cos"] = np.cos(2 * np.pi * df["month"] / 12)
            feature_names += ["month_sin", "month_cos"]

        # ── Price range volatility (toggled by include_price_range) ────────
        if include_price_range:
            df["price_range_7d"] = (
                df.groupby("block")["mcp"].transform(
                    lambda x: x.shift(1).rolling(7, min_periods=2).max()
                )
                - df.groupby("block")["mcp"].transform(
                    lambda x: x.shift(1).rolling(7, min_periods=2).min()
                )
            ).fillna(0)
            feature_names.append("price_range_7d")

        # ── Summer onset signal (India peak-demand season Apr-Jun) ─────────
        # is_summer: binary flag for April-June (peak cooling demand period)
        # max_temp_7d: 7-day rolling max temperature - captures heat accumulation
        # trend. Predicts demand spikes better than single-day temp alone.
        if include_summer_signal:
            df["is_summer"] = df["month"].isin([4, 5, 6]).astype(int)
            feature_names.append("is_summer")
            if "temperature" in df.columns:
                df["max_temp_7d"] = (
                    df.groupby("block")["temperature"]
                    .transform(lambda x: x.shift(1).rolling(7, min_periods=1).max())
                    .fillna(df["temperature"])
                )
                feature_names.append("max_temp_7d")

        # ── Renewable share - use lagged values to match prediction time ────
        # Key driver of near-zero RTM prices: high solar share → oversupply →
        # price collapse. Always included - no toggle needed, cost is trivial.
        if "lag_renewable_1d" in df.columns and "lag_demand_1d" in df.columns:
            df["renewable_share"] = (
                df["lag_renewable_1d"] / df["lag_demand_1d"].clip(lower=1)
            ).clip(0, 1)
            feature_names.append("renewable_share")

        df = df.dropna(subset=drop_subset)
        return df, feature_names

    def train(
        self,
        df: pd.DataFrame,
        test_size: float = 0.2,
        shuffle: bool = False,
        hyperparams: dict | None = None,
        tuning: dict | None = None,
        feature_cfg: dict | None = None,
        peak_block_weight: float = 2.0,
    ):
        """
        Train on historical price data.

        Parameters
        ----------
        hyperparams : dict  - Passed directly to HistGradientBoostingRegressor
        tuning      : dict  - If provided, runs CV search. Keys: method, n_iter, cv_folds, scoring, param_grid
        feature_cfg : dict  - Passed to _build_features (extra_lags, rolling_windows, …)
        """
        df = df[df["segment"] == self.segment].copy()
        if len(df) < NUM_BLOCKS * 10:
            raise ValueError(f"Need at least 10 days of data, got {len(df)} rows")

        feat_kwargs = feature_cfg or {}
        df, feature_names = self._build_features(df, **feat_kwargs)
        self.feature_names = feature_names

        X = df[feature_names].values
        y = df["mcp"].values

        # Keep index aligned so we can recover which dates went to train vs test
        idx = np.arange(len(df))
        idx_train, idx_test = train_test_split(idx, test_size=test_size, shuffle=shuffle)
        X_train, X_test = X[idx_train], X[idx_test]
        y_train, y_test = y[idx_train], y[idx_test]

        # ── Sample weights: peak blocks + recency ──────────────────────────
        # peak_block_weight > 1 → model optimizes harder on economically critical
        # mid-day blocks where DSM penalties and bid clearing are concentrated.
        # Recency weighting: exponential decay so recent months count more than
        # 2022-2023 data (different price regime due to renewable penetration shift).
        train_blocks = df["block"].values[idx_train]
        peak_mask = (train_blocks >= 32) & (train_blocks <= 64)
        sample_weights = np.where(peak_mask, float(peak_block_weight), 1.0)

        # Recency: half-life ~365 days → rows from 1yr ago get weight ~0.5
        train_dates = pd.to_datetime(df["date"].values[idx_train])
        latest_date = pd.to_datetime(df["date"].values).max()
        days_old = (latest_date - train_dates).days.astype(float)
        half_life = 365.0
        recency_weights = np.clip(np.exp(-np.log(2) * days_old / half_life), 0.15, 1.0)
        sample_weights = sample_weights * recency_weights

        all_dates = df["date"].values
        train_dates_sorted = sorted(set(all_dates[idx_train]))
        test_dates_sorted = sorted(set(all_dates[idx_test]))

        best_params = None

        if tuning:
            # ── Hyperparameter search ───────────────────────────────
            raw_grid = tuning.get("param_grid") or {}
            # Sanitise: sklearn requires each value to be a list/array.
            # Drop any keys with non-list values (e.g. Swagger placeholder {}).
            valid_grid = {k: v for k, v in raw_grid.items() if isinstance(v, (list, tuple))}
            param_grid = valid_grid if valid_grid else DEFAULT_PARAM_GRID
            method = tuning.get("method", "random")
            cv_folds = tuning.get("cv_folds", 5)
            scoring = tuning.get("scoring", "neg_mean_absolute_percentage_error")
            n_iter = tuning.get("n_iter", 30)

            base_estimator = HistGradientBoostingRegressor(random_state=42)

            # Use TimeSeriesSplit if not shuffled to respect temporal order
            cv = TimeSeriesSplit(n_splits=cv_folds) if not shuffle else cv_folds

            if method == "grid":
                searcher = GridSearchCV(
                    base_estimator,
                    param_grid,
                    cv=cv,
                    scoring=scoring,
                    n_jobs=-1,
                    verbose=0,
                )
            else:
                searcher = RandomizedSearchCV(
                    base_estimator,
                    param_grid,
                    n_iter=n_iter,
                    cv=cv,
                    scoring=scoring,
                    n_jobs=-1,
                    random_state=42,
                    verbose=0,
                )

            searcher.fit(X_train, y_train, sample_weight=sample_weights)
            self.model = searcher.best_estimator_
            best_params = searcher.best_params_
            cv_results_summary = {
                "best_score": round(float(searcher.best_score_), 4),
                "candidates_evaluated": len(searcher.cv_results_["mean_test_score"]),
            }
        else:
            # ── Direct training with explicit hyperparams ───────────
            params = {
                "max_iter": 300,
                "max_depth": 8,
                "learning_rate": 0.05,
                "min_samples_leaf": 10,
                "random_state": 42,
            }
            if hyperparams:
                # Override defaults with provided values
                params.update({k: v for k, v in hyperparams.items() if v is not None})
                params.setdefault("random_state", 42)

            self.model = HistGradientBoostingRegressor(**params)
            self.model.fit(X_train, y_train, sample_weight=sample_weights)
            cv_results_summary = None

        # ── Permutation importance on test set ──────────────────────
        perm_result = permutation_importance(
            self.model, X_test, y_test, n_repeats=5, random_state=42
        )
        self.feature_importances = perm_result.importances_mean
        self.feature_importances = self.feature_importances / max(
            self.feature_importances.sum(), 1e-10
        )

        # ── Save model + metadata ───────────────────────────────────
        self.train_dates: list[str] = train_dates_sorted
        self.test_dates: list[str] = test_dates_sorted
        with open(self.model_path, "wb") as f:
            pickle.dump(
                {
                    "model": self.model,
                    "importances": self.feature_importances,
                    "feature_names": self.feature_names,
                    "train_dates": train_dates_sorted,
                    "test_dates": test_dates_sorted,
                },
                f,
            )

        # ── Evaluate ────────────────────────────────────────────────
        preds = self.model.predict(X_test)
        test_mape = metrics.mape(y_test, preds)

        # Per-block sMAPE over the test rows, to surface the hardest blocks.
        test_df = df.iloc[idx_test][["block", "mcp"]].assign(pred=preds)
        block_smape = {
            int(block): metrics.smape(g["mcp"], g["pred"]) for block, g in test_df.groupby("block")
        }

        # Top features
        top_idx = np.argsort(self.feature_importances)[-10:][::-1]
        top_features = [
            {
                "feature": feature_names[i],
                "importance": round(float(self.feature_importances[i]), 4),
            }
            for i in top_idx
        ]

        result = {
            "mape": round(test_mape, 2) if test_mape is not None else None,
            "smape": round(metrics.smape(y_test, preds), 2),
            "rmse": round(metrics.rmse(y_test, preds), 2),
            "mae": round(metrics.mae(y_test, preds), 2),
            "r2": round(float(r2_score(y_test, preds)), 4),
            "train_size": len(X_train),
            "test_size": len(X_test),
            "n_features": len(feature_names),
            "feature_names": feature_names,
            "top_features": top_features,
            "block_smape_worst_5": {
                block: round(v, 2)
                for block, v in sorted(block_smape.items(), key=lambda x: x[1], reverse=True)[:5]
            },
        }
        if best_params:
            result["best_params"] = {k: _serialise(v) for k, v in best_params.items()}
        if cv_results_summary:
            result["cv_results"] = cv_results_summary
        return result

    def load(self):
        """Load a trained model from disk."""
        if self.model_path.exists():
            with open(self.model_path, "rb") as f:
                data = pickle.load(f)
            if isinstance(data, dict):
                self.model = data["model"]
                self.feature_importances = data["importances"]
                self.feature_names = data.get("feature_names", list(BASE_FEATURE_NAMES))
                self.train_dates: list[str] = data.get("train_dates", [])
                self.test_dates: list[str] = data.get("test_dates", [])
            else:
                self.model = data
                self.feature_importances = np.ones(len(BASE_FEATURE_NAMES)) / len(
                    BASE_FEATURE_NAMES
                )
                self.feature_names = list(BASE_FEATURE_NAMES)
                self.train_dates = []
                self.test_dates = []
            return True
        return False

    @property
    def uses_weather(self) -> bool:
        """Whether the trained model takes hourly weather features."""
        return any(fn in self.feature_names for fn in WEATHER_FEATURE_NAMES)

    def predict(
        self,
        target_date: str,
        history_df: pd.DataFrame,
        weather_by_hour: dict[int, dict] | None = None,
    ) -> list[dict]:
        """
        Generate price predictions for all 96 blocks on target_date.
        Returns list of dicts with prediction, confidence interval, and feature importances.

        weather_by_hour is target_date's hourly weather keyed 0-23, as returned by
        data.scrape_weather. When omitted, a model that uses weather fetches it itself;
        callers forecasting many dates should fetch the whole range once and pass it in.
        """
        if self.model is None:
            if not self.load():
                raise RuntimeError("No trained model found. Train first.")

        feature_names = self.feature_names or list(BASE_FEATURE_NAMES)

        # Build features for the target date using recent history
        target_dt = pd.Timestamp(target_date)
        blocks = []

        # We need lag features, so get recent history
        recent = history_df[history_df["segment"] == self.segment].copy()
        # Detect which extra features we need from the stored feature_names
        extra_lags = []
        rolling_windows = []
        include_dsr = "demand_supply_ratio" in feature_names
        include_momentum = "price_momentum" in feature_names
        include_ema = "ema_price" in feature_names

        for fn in feature_names:
            if fn.startswith("lag_price_") and fn not in (
                "lag_price_1d",
                "lag_price_7d",
            ):
                lag_d = int(fn.replace("lag_price_", "").replace("d", ""))
                extra_lags.append(lag_d)
            if fn.startswith("rolling_avg_"):
                w = int(fn.replace("rolling_avg_", "").replace("d", ""))
                if w not in rolling_windows:
                    rolling_windows.append(w)

        recent, _ = self._build_features(
            recent,
            extra_lags=extra_lags or None,
            rolling_windows=rolling_windows or [7],
            include_demand_supply_ratio=include_dsr,
            include_price_momentum=include_momentum,
            include_ema=include_ema,
        )

        # Get the most recent day's data as baseline for market context (demand, supply, temp, etc.)
        last_day = recent.groupby("block").last().reset_index()

        # Precompute exact per-block MCP lookups for lag features using the
        # raw (pre-feature-engineering) segment data.  This avoids the mismatch
        # where last_day.lag_price_7d contains T-1's 7d lag (= T-8) instead of
        # the correct T-7 day, which matters especially on weekends.
        raw_seg = history_df[history_df["segment"] == self.segment].copy()
        raw_seg["_date_str"] = raw_seg["date"].astype(str)

        target_1d_str = (target_dt - pd.Timedelta(days=1)).strftime("%Y-%m-%d")
        target_2d_str = (target_dt - pd.Timedelta(days=2)).strftime("%Y-%m-%d")
        target_7d_str = (target_dt - pd.Timedelta(days=7)).strftime("%Y-%m-%d")

        day_1d_map: dict = (
            raw_seg[raw_seg["_date_str"] == target_1d_str].set_index("block")["mcp"].to_dict()
        )
        day_2d_map: dict = (
            raw_seg[raw_seg["_date_str"] == target_2d_str].set_index("block")["mcp"].to_dict()
        )
        day_7d_map: dict = (
            raw_seg[raw_seg["_date_str"] == target_7d_str].set_index("block")["mcp"].to_dict()
        )

        # Build exact lookups for any extra lag features
        extra_lag_maps: dict[str, dict] = {}
        for fn in feature_names:
            if fn.startswith("lag_price_") and fn not in (
                "lag_price_1d",
                "lag_price_7d",
            ):
                lag_d = int(fn.replace("lag_price_", "").replace("d", ""))
                lag_date_str = (target_dt - pd.Timedelta(days=lag_d)).strftime("%Y-%m-%d")
                extra_lag_maps[fn] = (
                    raw_seg[raw_seg["_date_str"] == lag_date_str]
                    .set_index("block")["mcp"]
                    .to_dict()
                )

        # ── Rolling avg/std/median from raw_seg (matched to shifted training) ─
        # Training uses shift(1) before rolling, so rolling_avg_7d[T] = mean(T-7..T-1).
        # We replicate this exactly: take last 7 days strictly before target_date.
        rolling_avg_map: dict[int, float] = {}
        rolling_std_map: dict[int, float] = {}
        rolling_med_map: dict[int, float] = {}
        _any_rolling = any(
            fn in feature_names for fn in ("rolling_avg_7d", "rolling_std_7d", "rolling_median_7d")
        )
        if _any_rolling:
            _seg_before = raw_seg[pd.to_datetime(raw_seg["_date_str"]) < target_dt].copy()
            for _blk, _grp in _seg_before.groupby("block"):
                _vals = _grp.sort_values("date")["mcp"].tail(7)
                if "rolling_avg_7d" in feature_names:
                    rolling_avg_map[int(_blk)] = float(_vals.mean()) if len(_vals) > 0 else 0.0
                if "rolling_std_7d" in feature_names:
                    rolling_std_map[int(_blk)] = float(_vals.std(ddof=0)) if len(_vals) > 1 else 0.0
                if "rolling_median_7d" in feature_names:
                    rolling_med_map[int(_blk)] = float(_vals.median()) if len(_vals) > 0 else 0.0

        # Compute same_dow_avg_4w: rolling mean of the past 4 same-weekday prices
        # for each block, derived directly from raw history (no last_day mismatch).
        target_dow = int(target_dt.dayofweek)
        same_dow_avg_map: dict = {}
        same_dow_history = raw_seg[
            (pd.to_datetime(raw_seg["_date_str"]) < target_dt)
            & (pd.to_datetime(raw_seg["_date_str"]).dt.dayofweek == target_dow)
        ].sort_values("date")
        if "same_dow_avg_4w" in feature_names:
            for blk, grp in same_dow_history.groupby("block"):
                tail4 = grp["mcp"].tail(4)
                same_dow_avg_map[int(blk)] = float(tail4.mean()) if len(tail4) > 0 else float("nan")

        # ── Weather forecast for target_date (per hour, keyed 0-23) ───────────
        # Only fetched if the model was trained with weather features and the
        # caller did not supply it.
        if weather_by_hour is None:
            weather_by_hour = {}
            if self.uses_weather:
                try:
                    from data.scrape_weather import fetch_forecast_for_date

                    weather_by_hour = fetch_forecast_for_date(target_date)
                except Exception:
                    pass  # silently fall through to NaN / last_day values

        # ── Holiday features for target_date ──────────────────────────────────
        _is_holiday = 0
        _days_to_holiday = 7
        if "is_holiday" in feature_names or "days_to_holiday" in feature_names:
            try:
                from data.enrich_pipeline import compute_holiday_features

                _h_series, _dtoh_series = compute_holiday_features(pd.Series([target_date]))
                _is_holiday = int(_h_series.iloc[0])
                _days_to_holiday = int(_dtoh_series.iloc[0])
            except Exception:
                pass

        # ── Derived cyclic / range features ───────────────────────────────────
        _month_sin = (
            float(np.sin(2 * np.pi * target_dt.month / 12)) if "month_sin" in feature_names else 0.0
        )
        _month_cos = (
            float(np.cos(2 * np.pi * target_dt.month / 12)) if "month_cos" in feature_names else 0.0
        )
        _is_summer = int(target_dt.month in (4, 5, 6)) if "is_summer" in feature_names else 0

        # max_temp_7d: rolling max temperature of the last 7 days (per block)
        _max_temp_7d_map: dict = {}
        if "max_temp_7d" in feature_names:
            cutoff_7d = target_dt - pd.Timedelta(days=7)
            temp_recent = raw_seg[
                (pd.to_datetime(raw_seg["_date_str"]) >= cutoff_7d)
                & (pd.to_datetime(raw_seg["_date_str"]) < target_dt)
            ]
            if not temp_recent.empty and "temperature" in temp_recent.columns:
                for blk, grp in temp_recent.groupby("block"):
                    vals = grp["temperature"].dropna()
                    _max_temp_7d_map[int(blk)] = float(vals.max()) if len(vals) > 0 else 30.0

        feature_rows: list[list[float]] = []
        block_rolling_std: list[float] = []
        for block_num in range(1, NUM_BLOCKS + 1):
            row = last_day[last_day["block"] == block_num]

            hour = (block_num - 1) // 4
            block_in_hour = (block_num - 1) % 4
            day_of_week = target_dt.dayofweek
            month = target_dt.month
            is_weekend = int(day_of_week >= 5)
            block_sin = np.sin(2 * np.pi * block_num / NUM_BLOCKS)
            block_cos = np.cos(2 * np.pi * block_num / NUM_BLOCKS)

            # Use exact T-1 and T-7 prices rather than shifted columns from last_day
            fallback_mcp = float(row["mcp"].values[0]) if len(row) > 0 else 4.0
            lag_1d = day_1d_map.get(block_num, fallback_mcp)
            lag_7d = day_7d_map.get(block_num, lag_1d)
            # Rolling avg/std/median computed directly from last 7 days (matches shifted training)
            rolling_avg = rolling_avg_map.get(block_num, lag_1d)
            rolling_std = rolling_std_map.get(block_num, 0.5)

            # T-1 demand/supply/renewable: exactly known at prediction time (D-1).
            # No approximation needed - closes the train/predict feature mismatch.
            _d1_demand = (
                float(row["demand_mw"].values[0])
                if len(row) > 0
                and "demand_mw" in row.columns
                and not pd.isna(row["demand_mw"].values[0])
                else 45000
            )
            _d1_supply = (
                float(row["supply_mw"].values[0])
                if len(row) > 0
                and "supply_mw" in row.columns
                and not pd.isna(row["supply_mw"].values[0])
                else 44000
            )
            _d1_renew = (
                float(row["renewable_gen_mw"].values[0])
                if len(row) > 0
                and "renewable_gen_mw" in row.columns
                and not pd.isna(row["renewable_gen_mw"].values[0])
                else 5000
            )
            demand = _d1_demand
            supply = _d1_supply
            renewable = _d1_renew
            temp = (
                float(row["temperature"].values[0])
                if len(row) > 0
                and "temperature" in row.columns
                and not pd.isna(row["temperature"].values[0])
                else 30.0
            )

            # Weather for this block's hour (from Open-Meteo forecast)
            block_hour = (block_num - 1) // 4
            w = weather_by_hour.get(block_hour, {})

            # Build feature vector dynamically based on stored feature_names
            feat_values = {}
            feat_values["hour"] = hour
            feat_values["block_in_hour"] = block_in_hour
            feat_values["day_of_week"] = day_of_week
            feat_values["month"] = month
            feat_values["is_weekend"] = is_weekend
            feat_values["lag_demand_1d"] = demand
            feat_values["lag_supply_1d"] = supply
            feat_values["lag_renewable_1d"] = renewable
            if "demand_supply_ratio" in feature_names:
                feat_values["demand_supply_ratio"] = demand / max(supply, 1)
            feat_values["temperature"] = w.get("temperature_2m", temp)
            feat_values["lag_price_1d"] = lag_1d
            feat_values["lag_price_7d"] = lag_7d
            feat_values["rolling_avg_7d"] = rolling_avg
            feat_values["rolling_std_7d"] = rolling_std
            feat_values["block_sin"] = block_sin
            feat_values["block_cos"] = block_cos
            # price_momentum[T] = (mcp[T-1] - mcp[T-2]) / mcp[T-2]
            # Training uses shift(1) of pct_change - must match exactly.
            if "price_momentum" in feature_names:
                _lag2 = day_2d_map.get(block_num, lag_1d)
                feat_values["price_momentum"] = (
                    (lag_1d - _lag2) / max(abs(_lag2), 1e-6) if _lag2 != lag_1d else 0.0
                )
            # ema_price[T] = ewm up to T-1.  last_day holds ewm up to T-2,
            # so apply one more EMA step: alpha*mcp[T-1] + (1-alpha)*ema[T-2].
            if "ema_price" in feature_names:
                _alpha = 2.0 / (7 + 1)
                _ema_prev = (
                    float(row["ema_price"].values[0])
                    if len(row) > 0
                    and "ema_price" in row.columns
                    and not pd.isna(row["ema_price"].values[0])
                    else lag_1d
                )
                feat_values["ema_price"] = _alpha * lag_1d + (1.0 - _alpha) * _ema_prev
            # Weather features
            feat_values["wind_speed_ms"] = w.get("wind_speed_ms", float("nan"))
            feat_values["solar_radiation_wm2"] = w.get("solar_radiation_wm2", float("nan"))
            feat_values["cloud_cover_pct"] = w.get("cloud_cover_pct", float("nan"))
            # Holiday features
            feat_values["is_holiday"] = _is_holiday
            feat_values["days_to_holiday"] = _days_to_holiday
            # Cyclic month encoding
            feat_values["month_sin"] = _month_sin
            feat_values["month_cos"] = _month_cos
            # Summer onset signal
            feat_values["is_summer"] = _is_summer
            feat_values["max_temp_7d"] = _max_temp_7d_map.get(
                block_num, feat_values.get("temperature", 30.0)
            )
            # Renewable share
            feat_values["renewable_share"] = feat_values.get("lag_renewable_1d", 0) / max(
                feat_values.get("lag_demand_1d", 1), 1
            )

            # Populate dynamic features - use exact date lookups for lag features,
            # same-dow lookup for same_dow_avg_4w, rolling maps for rolling stats,
            # fall back to last_day's engineered columns for everything else.
            for fn in feature_names:
                if fn not in feat_values:
                    if fn == "same_dow_avg_4w":
                        fallback = feat_values.get("ema_price", lag_1d)
                        feat_values[fn] = same_dow_avg_map.get(block_num, fallback)
                        if pd.isna(feat_values[fn]):
                            feat_values[fn] = fallback
                    elif fn == "rolling_median_7d":
                        feat_values[fn] = rolling_med_map.get(block_num, lag_1d)
                    elif fn in extra_lag_maps:
                        feat_values[fn] = extra_lag_maps[fn].get(block_num, 0.0)
                    elif len(row) > 0 and fn in row.columns:
                        val = row[fn].values[0]
                        feat_values[fn] = float(val) if not pd.isna(val) else 0.0
                    else:
                        feat_values[fn] = 0.0

            feature_rows.append([feat_values[fn] for fn in feature_names])
            block_rolling_std.append(rolling_std)

        # One call for all blocks: each predict call walks every tree, so its cost
        # is nearly the same for one row as for 96.
        preds = self.model.predict(np.array(feature_rows))

        # Feature importances (from permutation importance computed during training)
        importances = (
            self.feature_importances
            if self.feature_importances is not None
            else np.ones(len(feature_names)) / len(feature_names)
        )
        top_idx = np.argsort(importances)[-5:][::-1]
        top_features = [
            {
                "feature": feature_names[i],
                "importance": round(float(importances[i]), 4),
            }
            for i in top_idx
            if i < len(feature_names)
        ]

        for block_num, raw_pred, rolling_std in zip(
            range(1, NUM_BLOCKS + 1), preds, block_rolling_std, strict=True
        ):
            pred = max(float(raw_pred), 0.01)  # price can't be negative

            # Confidence interval from rolling std + model uncertainty
            uncertainty = max(rolling_std * 0.5, pred * 0.08)
            conf_low = max(pred - 1.96 * uncertainty, 0.01)
            conf_high = pred + 1.96 * uncertainty

            blocks.append(
                {
                    "block": block_num,
                    "predicted_price": round(pred, 4),
                    "confidence_low": round(conf_low, 4),
                    "confidence_high": round(conf_high, 4),
                    "volatility": round(uncertainty, 4),
                    "top_features": top_features,
                }
            )

        return blocks
