# Model Feature Reference

Total: **31 features** across 6 categories.  
The final count per trained model may vary if extra lags or rolling windows are configured via `feature_cfg` at training time.

---

## Temporal (5)

| # | Feature | Description |
|---|---------|-------------|
| 1 | `hour` | Hour of day (0-23), derived from block: `(block - 1) // 4` |
| 2 | `block_in_hour` | Which 15-min slot within the hour (0-3): `(block - 1) % 4` |
| 3 | `day_of_week` | Monday=0 … Sunday=6 |
| 4 | `month` | Calendar month (1-12) |
| 5 | `is_weekend` | Binary: 1 if Saturday or Sunday |

---

## Cyclical Encoding (4)

Prevents the model treating block 1 and block 96 as "far apart" on a linear scale.

| # | Feature | Description |
|---|---------|-------------|
| 6 | `block_sin` | `sin(2π × block / 96)` |
| 7 | `block_cos` | `cos(2π × block / 96)` |
| 8 | `month_sin` | `sin(2π × month / 12)` |
| 9 | `month_cos` | `cos(2π × month / 12)` |

---

## Price Lags & Rolling Stats (7)

All rolling features use `shift(1)` before rolling so no future price leaks into training.

| # | Feature | Description |
|---|---------|-------------|
| 10 | `lag_price_1d` | Previous day's MCP for same block - single strongest predictor |
| 11 | `lag_price_7d` | MCP from 7 days ago for same block - captures weekly pattern |
| 12 | `rolling_avg_7d` | Mean of last 7 days' prices per block |
| 13 | `rolling_std_7d` | Std dev of last 7 days' prices per block - volatility proxy |
| 14 | `rolling_median_7d` | Median of last 7 days - robust to outlier price spikes |
| 15 | `price_range_7d` | Max − Min price over last 7 days per block - volatility range |
| 16 | `same_dow_avg_4w` | Mean price of the last 4 same-weekday occurrences per block (e.g. last 4 Mondays at 12:00) |

---

## Price Dynamics (2)

| # | Feature | Description |
|---|---------|-------------|
| 17 | `price_momentum` | `(price[T-1] − price[T-2]) / price[T-2]` - rate of change, shifted to avoid leakage |
| 18 | `ema_price` | Exponential moving average (span=7) shifted by 1 day - trend smoother |

---

## Grid State (5)

All use T-1 lagged values, matching what is actually available at prediction time.

| # | Feature | Description |
|---|---------|-------------|
| 19 | `lag_demand_1d` | Previous day's demand in MW - load expectation proxy |
| 20 | `lag_supply_1d` | Previous day's supply in MW - available generation proxy |
| 21 | `lag_renewable_1d` | Previous day's renewable injection in MW - key driver of low RTM prices |
| 22 | `demand_supply_ratio` | `lag_demand_1d / lag_supply_1d` - grid tightness |
| 23 | `renewable_share` | `lag_renewable_1d / lag_demand_1d` - renewable penetration; high → oversupply → price collapse |

---

## Weather (5)

Fetched from Open-Meteo API at prediction time. During training, sourced from the enriched `price_history` DB rows.

| # | Feature | Description |
|---|---------|-------------|
| 24 | `temperature` | Ambient temperature in °C at block time |
| 25 | `max_temp_7d` | Rolling max temperature over past 7 days per block - captures heat accumulation and sustained grid stress (stronger signal than single-day temp) |
| 26 | `wind_speed_ms` | Wind speed in m/s - proxy for wind generation availability |
| 27 | `solar_radiation_wm2` | Solar irradiance in W/m² - direct proxy for solar output (most relevant blocks 20-60, 05:00-15:00) |
| 28 | `cloud_cover_pct` | Cloud cover % - inversely correlated with solar output |

---

## Calendar (3)

| # | Feature | Description |
|---|---------|-------------|
| 29 | `is_holiday` | Binary: 1 if Indian public holiday - demand typically drops, clearing prices lower |
| 30 | `days_to_holiday` | Days until nearest upcoming holiday - anticipatory demand shift |
| 31 | `is_summer` | Binary: 1 if month is April, May, or June - India peak cooling demand season |

---

## Notes

### Why weather features appear low in permutation importance
`temperature` is collinear with `month`, `is_summer`, and `max_temp_7d` - all of which encode the same seasonal heat signal. Permutation importance is a **marginal** measure: shuffling `temperature` barely degrades accuracy because the other three features compensate. The signal is present; it's absorbed into the temporal structure.

`wind_speed_ms`, `solar_radiation_wm2`, `cloud_cover_pct` suffer a different problem: at prediction time the Open-Meteo API call silently fails in offline/VM environments, making these features `NaN` at inference. `HistGradientBoostingRegressor` handles NaN natively by routing them down a different decision tree path, but this means the model trains on real values and predicts on NaN-paths - reducing measured importance.

### Train vs predict feature source

| Feature group | Training source | Prediction source |
|---------------|----------------|-------------------|
| Price lags | Shifted DB history | Exact date lookups from DB |
| Rolling stats | Shifted rolling window | Pre-computed from raw DB before target date |
| Demand/supply/renewable | Lagged DB rows | T-1 day from DB (`last_day`) |
| Temperature | Enriched DB rows | Open-Meteo forecast API / `last_day` fallback |
| Wind/solar/cloud | Enriched DB rows | Open-Meteo forecast API / NaN if unavailable |
| Holiday | `enrich_pipeline.compute_holiday_features()` | Same function on target date |
