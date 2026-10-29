import asyncio
import io
import logging
from datetime import datetime, timedelta

import numpy as np
import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sklearn.metrics import r2_score
from sqlalchemy import func as sql_func
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from common.database import get_db
from common.forecasts import latest_forecasts
from common.models import Forecast, PriceHistory
from common.schemas import ForecastBlock, ForecastResponse, TrainRequest
from data.scrape_weather import fetch_weather_hourly

from . import metrics
from .model import PriceForecastModel

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/forecast", tags=["Forecast"])

# Trained models are loaded from disk once per segment.
_models: dict[str, PriceForecastModel] = {}

# Days of history the model sees for lag and rolling features.
_CONTEXT_DAYS = 30
# Backtest days with less prior history than this are skipped.
_MIN_CONTEXT_DAYS = 7

_HISTORY_COLUMNS = (
    PriceHistory.date,
    PriceHistory.block,
    PriceHistory.segment,
    PriceHistory.mcp,
    PriceHistory.mcv,
    PriceHistory.demand_mw,
    PriceHistory.supply_mw,
    PriceHistory.renewable_gen_mw,
    PriceHistory.temperature,
)


def _get_model(segment: str) -> PriceForecastModel:
    if segment not in _models:
        m = PriceForecastModel(segment=segment)
        m.load()
        _models[segment] = m
    return _models[segment]


def _require_model(segment: str) -> PriceForecastModel:
    model = _get_model(segment)
    if model.model is None:
        raise HTTPException(503, f"No trained model for {segment}. POST /forecast/train first.")
    return model


def _validate_date(d: str) -> str:
    try:
        datetime.strptime(d, "%Y-%m-%d")
    except ValueError as exc:
        raise HTTPException(422, f"Invalid date: {d}") from exc
    return d


def _validate_block_range(block_start: int, block_end: int) -> None:
    if block_start > block_end:
        raise HTTPException(422, "block_start must be <= block_end")


def _in_block_range(blocks: list[dict], block_start: int, block_end: int) -> list[dict]:
    return [b for b in blocks if block_start <= b["block"] <= block_end]


async def _history(
    db: AsyncSession, segment: str, before: str | None = None, days: int | None = None
) -> pd.DataFrame:
    """
    Price history for a segment, oldest first.

    *before* excludes that date and everything after it, so a forecast for a past date
    never sees its own actuals.
    *days* keeps only the most recent N days.
    """
    q = select(*_HISTORY_COLUMNS).where(PriceHistory.segment == segment)
    if before is not None:
        q = q.where(PriceHistory.date < before)
    q = q.order_by(PriceHistory.date.desc(), PriceHistory.block)
    if days is not None:
        q = q.limit(96 * days)
    rows = (await db.execute(q)).all()
    df = pd.DataFrame(rows, columns=[c.key for c in _HISTORY_COLUMNS])
    return df.sort_values(["date", "block"], kind="stable").reset_index(drop=True)


async def _range_weather(
    model: PriceForecastModel, date_from: str, date_to: str
) -> dict[str, dict[int, dict]]:
    """
    Hourly weather for every date in a range, in one request instead of one per date.

    Empty when the model takes no weather features or the fetch fails.
    The model then falls back to its defaults, as it does for a single-date forecast.
    """
    if not model.uses_weather:
        return {}
    try:
        return await asyncio.to_thread(fetch_weather_hourly, date_from, date_to)
    except Exception as exc:
        logger.warning("Weather fetch failed for %s to %s: %s", date_from, date_to, exc)
        return {}


def _store(db: AsyncSession, target_date: str, segment: str, blocks: list[dict]) -> None:
    for b in blocks:
        db.add(
            Forecast(
                target_date=target_date,
                block=b["block"],
                segment=segment,
                predicted_price=b["predicted_price"],
                confidence_low=b["confidence_low"],
                confidence_high=b["confidence_high"],
                volatility=b["volatility"],
                top_features=b["top_features"],
            )
        )


@router.get("/predict", response_model=ForecastResponse)
async def predict_prices(
    target_date: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"),
    segment: str = Query(..., pattern=r"^(DAM|RTM|TAM)$"),
    block_start: int = Query(default=1, ge=1, le=96),
    block_end: int = Query(default=96, ge=1, le=96),
    db: AsyncSession = Depends(get_db),
):
    """
    Forecast all 96 blocks of a delivery date, optionally filtered to a block range.

    Features are built only from history before target_date.
    """
    target_date = _validate_date(target_date)
    _validate_block_range(block_start, block_end)
    model = _require_model(segment)

    history_df = await _history(db, segment, before=target_date, days=_CONTEXT_DAYS)
    if history_df.empty:
        raise HTTPException(400, f"No price history before {target_date}. Load data first.")

    blocks = await asyncio.to_thread(model.predict, target_date, history_df)
    blocks = _in_block_range(blocks, block_start, block_end)
    _store(db, target_date, segment, blocks)
    await db.commit()

    return ForecastResponse(
        target_date=target_date,
        segment=segment,
        blocks=[ForecastBlock(**b) for b in blocks],
    )


@router.get("/predict-range")
async def predict_prices_range(
    date_from: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"),
    date_to: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"),
    segment: str = Query(..., pattern=r"^(DAM|RTM|TAM)$"),
    block_start: int = Query(default=1, ge=1, le=96),
    block_end: int = Query(default=96, ge=1, le=96),
    db: AsyncSession = Depends(get_db),
):
    """
    Forecast each day in a range of up to 30 days, optionally filtered to a block range.

    Each day is forecast only from history before that day.
    """
    date_from = _validate_date(date_from)
    date_to = _validate_date(date_to)
    _validate_block_range(block_start, block_end)
    d0 = datetime.strptime(date_from, "%Y-%m-%d")
    d1 = datetime.strptime(date_to, "%Y-%m-%d")
    if d0 > d1:
        raise HTTPException(422, "date_from must be <= date_to")
    if (d1 - d0).days > 29:
        raise HTTPException(422, "Date range cannot exceed 30 days")

    model = _require_model(segment)

    # One query covers the context before date_from and every day inside the range.
    full_df = await _history(db, segment, before=date_to, days=_CONTEXT_DAYS + (d1 - d0).days)
    if full_df.empty:
        raise HTTPException(400, f"No price history before {date_to}. Load data first.")

    weather = await _range_weather(model, date_from, date_to)

    def forecast_days() -> list[dict]:
        days = []
        current = d0
        while current <= d1:
            date_str = current.strftime("%Y-%m-%d")
            context = full_df[full_df["date"] < date_str].tail(96 * _CONTEXT_DAYS)
            blocks = model.predict(date_str, context, weather.get(date_str, {}))
            days.append(
                {"date": date_str, "blocks": _in_block_range(blocks, block_start, block_end)}
            )
            current += timedelta(days=1)
        return days

    days = await asyncio.to_thread(forecast_days)
    for day in days:
        _store(db, day["date"], segment, day["blocks"])
    await db.commit()

    return {
        "segment": segment,
        "date_from": date_from,
        "date_to": date_to,
        "days": days,
    }


async def _latest_run(db: AsyncSession, segment: str) -> tuple[str, list[Forecast]]:
    """The delivery date of the newest stored forecast and its latest row per block."""
    target_date = (
        await db.execute(
            select(Forecast.target_date)
            .where(Forecast.segment == segment)
            .order_by(Forecast.id.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if target_date is None:
        raise HTTPException(404, f"No stored forecast for {segment}.")
    return target_date, list((await latest_forecasts(db, target_date, segment)).values())


@router.get("/latest", response_model=ForecastResponse)
async def get_latest_forecast(
    segment: str = Query(..., pattern=r"^(DAM|RTM|TAM)$"),
    db: AsyncSession = Depends(get_db),
):
    """The most recently generated forecast for a segment."""
    target_date, rows = await _latest_run(db, segment)
    blocks = [
        ForecastBlock(
            block=r.block,
            predicted_price=r.predicted_price,
            confidence_low=r.confidence_low if r.confidence_low is not None else r.predicted_price,
            confidence_high=r.confidence_high
            if r.confidence_high is not None
            else r.predicted_price,
            volatility=r.volatility or 0.0,
            top_features=r.top_features or [],
        )
        for r in rows
    ]
    return ForecastResponse(target_date=target_date, segment=segment, blocks=blocks)


@router.get("/export-csv")
async def export_forecast_csv(
    segment: str = Query(..., pattern=r"^(DAM|RTM|TAM)$"),
    db: AsyncSession = Depends(get_db),
):
    """The most recently generated forecast for a segment as CSV."""
    target_date, rows = await _latest_run(db, segment)
    df = pd.DataFrame(
        [
            {
                "block": r.block,
                "target_date": r.target_date,
                "segment": segment,
                "predicted_price_inr_kwh": r.predicted_price,
                "confidence_low": r.confidence_low,
                "confidence_high": r.confidence_high,
                "volatility": r.volatility,
            }
            for r in rows
        ]
    )
    buf = io.StringIO()
    df.to_csv(buf, index=False)
    filename = f"forecast_{segment}_{target_date}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/history")
async def get_price_history(
    segment: str = Query(..., pattern=r"^(DAM|RTM|TAM)$"),
    days: int = Query(default=7, ge=1, le=60),
    db: AsyncSession = Depends(get_db),
):
    """The last `days` days of cleared prices for a segment, newest first."""
    result = await db.execute(
        select(PriceHistory.date, PriceHistory.block, PriceHistory.mcp)
        .where(PriceHistory.segment == segment)
        .order_by(PriceHistory.date.desc(), PriceHistory.block)
        .limit(days * 96)
    )
    return [{"date": r.date, "block": r.block, "mcp": r.mcp} for r in result.all()]


@router.get("/model-info")
async def get_model_info(
    segment: str = Query(..., pattern=r"^(DAM|RTM|TAM)$"),
):
    """Metadata about the loaded model: its train and test dates."""
    model = _require_model(segment)
    train_dates = getattr(model, "train_dates", [])
    test_dates = getattr(model, "test_dates", [])
    return {
        "segment": segment,
        "train_dates": train_dates,
        "test_dates": test_dates,
        "train_count": len(train_dates),
        "test_count": len(test_dates),
        "trained_on": f"{train_dates[0]} to {train_dates[-1]}" if train_dates else None,
    }


@router.get("/data-coverage")
async def get_data_coverage(
    segment: str = Query(..., pattern=r"^(DAM|RTM|TAM)$"),
    db: AsyncSession = Depends(get_db),
):
    """Every distinct date with price history for a segment."""
    result = await db.execute(
        select(PriceHistory.date)
        .where(PriceHistory.segment == segment)
        .distinct()
        .order_by(PriceHistory.date)
    )
    return {"segment": segment, "dates": [r.date for r in result.all()]}


def _backtest(
    model: PriceForecastModel,
    full_df: pd.DataFrame,
    d0: datetime,
    d1: datetime,
    weather: dict[str, dict[int, dict]],
) -> tuple[list[dict], list[float], list[float]]:
    """
    Forecast each day in [d0, d1] from the history before it and score it against its actuals.

    Blocking, so callers run it in a thread.
    Returns the per-day results and every scored actual and prediction, in order.
    """
    model_train_dates = set(getattr(model, "train_dates", []))
    model_test_dates = set(getattr(model, "test_dates", []))

    all_predicted: list[float] = []
    all_actual: list[float] = []
    daily_results = []

    current = d0
    while current <= d1:
        date_str = current.strftime("%Y-%m-%d")
        current += timedelta(days=1)

        actuals_day = full_df[full_df["date"] == date_str]
        if actuals_day.empty:
            continue
        actuals_map = dict(
            zip(actuals_day["block"].astype(int), actuals_day["mcp"].astype(float), strict=True)
        )

        context = full_df[full_df["date"] < date_str]
        if len(context) < 96 * _MIN_CONTEXT_DAYS:
            continue
        predicted_blocks = model.predict(
            date_str, context.tail(96 * _CONTEXT_DAYS), weather.get(date_str, {})
        )

        blocks_out = []
        day_predicted, day_actual = [], []
        for pb in predicted_blocks:
            actual = actuals_map.get(pb["block"])
            if actual is None:
                continue
            pred = pb["predicted_price"]
            err_pct = metrics.percentage_error(actual, pred)
            blocks_out.append(
                {
                    "block": pb["block"],
                    "predicted": round(pred, 4),
                    "actual": round(actual, 4),
                    "error_pct": round(err_pct, 2) if err_pct is not None else None,
                }
            )
            day_predicted.append(pred)
            day_actual.append(actual)

        if not day_predicted:
            continue
        all_predicted.extend(day_predicted)
        all_actual.extend(day_actual)

        day_mape = metrics.mape(day_actual, day_predicted)
        daily_results.append(
            {
                "date": date_str,
                "data_split": (
                    "train"
                    if date_str in model_train_dates
                    else "test"
                    if date_str in model_test_dates
                    else "unseen"
                ),
                "mape": round(day_mape, 2) if day_mape is not None else None,
                "smape": round(metrics.smape(day_actual, day_predicted), 2),
                "mae": round(metrics.mae(day_actual, day_predicted), 4),
                "rmse": round(metrics.rmse(day_actual, day_predicted), 4),
                "avg_predicted": round(float(np.mean(day_predicted)), 4),
                "avg_actual": round(float(np.mean(day_actual)), 4),
                "blocks": blocks_out,
            }
        )

    return daily_results, all_actual, all_predicted


@router.get("/evaluate")
async def evaluate_forecast(
    start_date: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"),
    end_date: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"),
    segment: str = Query(..., pattern=r"^(DAM|RTM|TAM)$"),
    db: AsyncSession = Depends(get_db),
):
    """
    Backtest the trained model against actual prices.

    Each date in [start_date, end_date] is forecast from history before that date only,
    then compared with its actuals.
    Returns per-day and aggregate MAPE, sMAPE, MAE, RMSE and R².
    MAPE excludes blocks priced below metrics.MAPE_PRICE_FLOOR and is null when none remain.
    """
    start_date = _validate_date(start_date)
    end_date = _validate_date(end_date)
    d0 = datetime.strptime(start_date, "%Y-%m-%d")
    d1 = datetime.strptime(end_date, "%Y-%m-%d")
    if d0 > d1:
        raise HTTPException(422, "start_date must be <= end_date")
    if (d1 - d0).days > 29:
        raise HTTPException(422, "Evaluation range cannot exceed 30 days")

    model = _require_model(segment)

    full_df = await _history(db, segment)
    if full_df.empty:
        raise HTTPException(400, "No historical data available.")

    weather = await _range_weather(model, start_date, end_date)
    daily_results, all_actual, all_predicted = await asyncio.to_thread(
        _backtest, model, full_df, d0, d1, weather
    )

    if not daily_results:
        raise HTTPException(404, "No dates with actuals and enough prior history in the range.")

    # Rank days by MAPE, falling back to sMAPE for days priced entirely below the floor.
    def day_error(d: dict) -> float:
        return d["mape"] if d["mape"] is not None else d["smape"]

    best_day = min(daily_results, key=day_error)
    worst_day = max(daily_results, key=day_error)
    agg_mape = metrics.mape(all_actual, all_predicted)

    return {
        "segment": segment,
        "start_date": start_date,
        "end_date": end_date,
        "days_evaluated": len(daily_results),
        "aggregate": {
            "mape": round(agg_mape, 2) if agg_mape is not None else None,
            "smape": round(metrics.smape(all_actual, all_predicted), 2),
            "mae": round(metrics.mae(all_actual, all_predicted), 4),
            "rmse": round(metrics.rmse(all_actual, all_predicted), 4),
            "r2": round(float(r2_score(all_actual, all_predicted)), 4),
        },
        "best_day": {k: best_day[k] for k in ("date", "mape", "smape")},
        "worst_day": {k: worst_day[k] for k in ("date", "mape", "smape")},
        "daily": daily_results,
    }


@router.get("/health")
async def forecast_health(db: AsyncSession = Depends(get_db)):
    """Row counts, latest price date and latest forecast time per segment."""
    status = {"status": "ok", "segments": {}}
    for seg in ("DAM", "RTM", "TAM"):
        row = (
            await db.execute(
                select(
                    sql_func.max(PriceHistory.date).label("latest_data"),
                    sql_func.count(PriceHistory.id).label("row_count"),
                ).where(PriceHistory.segment == seg)
            )
        ).one()
        latest_forecast = (
            await db.execute(
                select(sql_func.max(Forecast.created_at)).where(Forecast.segment == seg)
            )
        ).scalar_one_or_none()
        status["segments"][seg] = {
            "latest_data": row.latest_data,
            "row_count": row.row_count,
            "latest_forecast": str(latest_forecast) if latest_forecast else None,
        }
    return status


@router.post("/train")
async def train_model(req: TrainRequest | None = None, db: AsyncSession = Depends(get_db)):
    """
    Train the forecasting model on all price history for a segment.

    Send an empty POST for defaults, or a JSON body to customise:
    - **hyperparams**: direct model params (max_iter, learning_rate, ...)
    - **tuning**: enable CV search (method, n_iter, cv_folds, param_grid)
    - **features**: extra lags, rolling windows, demand/supply ratio, EMA, momentum
    """
    req = req or TrainRequest()
    segment = req.segment

    df = await _history(db, segment)
    if df.empty:
        raise HTTPException(400, "No historical data. Load data first.")

    if req.max_days:
        dates = sorted(df["date"].unique())[-req.max_days :]
        df = df[df["date"].isin(dates)]

    train_kwargs = {
        "test_size": req.test_size,
        "shuffle": req.shuffle,
        "peak_block_weight": req.peak_block_weight,
    }
    if req.hyperparams:
        train_kwargs["hyperparams"] = req.hyperparams.model_dump(exclude_none=True)
    if req.tuning:
        train_kwargs["tuning"] = req.tuning.model_dump(exclude_none=True)
    if req.features:
        train_kwargs["feature_cfg"] = req.features.model_dump()

    model = PriceForecastModel(segment=segment)
    try:
        train_metrics = await asyncio.to_thread(model.train, df, **train_kwargs)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    _models[segment] = model

    return {"status": "trained", "segment": segment, "metrics": train_metrics}
