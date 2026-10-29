"""
Nightly data pipeline.

At SCHEDULER_CRON_HOUR:SCHEDULER_CRON_MINUTE (SCHEDULER_TIMEZONE, default Asia/Kolkata):
  1. scrape the previous day's DAM, RTM and TAM prices
  2. score the previous day's forecasts against the settled prices
  3. retrain each segment (or only degraded segments when SCHEDULER_RETRAIN_ENABLED=false)
Thirty minutes later the new rows are enriched with weather data.

Disabled unless SCHEDULER_ENABLED=true.
"""

import asyncio
import json
import logging
import os
import sqlite3
from contextlib import closing
from datetime import timedelta
from zoneinfo import ZoneInfo

import pandas as pd
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from common.config import DB_PATH, SEGMENTS, market_today

logger = logging.getLogger(__name__)

scheduler: AsyncIOScheduler | None = None

_MIN_SCORED_BLOCKS = 10


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


def _env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        logger.warning("Invalid int for %s=%s, using default=%s", name, value, default)
        return default


def _env_float(name: str, default: float) -> float:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return float(value)
    except ValueError:
        logger.warning("Invalid float for %s=%s, using default=%s", name, value, default)
        return default


def _timezone() -> ZoneInfo:
    return ZoneInfo(os.getenv("SCHEDULER_TIMEZONE", "Asia/Kolkata"))


def _train_segment(segment: str) -> dict:
    from forecast_service.model import PriceForecastModel

    with closing(sqlite3.connect(DB_PATH)) as conn:
        df = pd.read_sql_query(
            """
            SELECT date, block, segment, mcp, mcv, demand_mw, supply_mw, renewable_gen_mw, temperature
            FROM price_history
            WHERE segment = ?
            ORDER BY date, block
            """,
            conn,
            params=(segment,),
        )

    model = PriceForecastModel(segment=segment)
    return model.train(df, test_size=0.2, shuffle=False)


def _feedback_loop_sync() -> dict[str, float]:
    """
    Score yesterday's forecasts against settled prices and record each result in the audit log.

    Uses the latest forecast per block.
    Returns {segment: mape} for segments with at least _MIN_SCORED_BLOCKS scored blocks.
    A MAPE above FEEDBACK_MAPE_THRESHOLD forces a retrain even when
    SCHEDULER_RETRAIN_ENABLED=false.
    """
    from forecast_service import metrics

    mape_threshold = _env_float("FEEDBACK_MAPE_THRESHOLD", 15.0)
    yesterday = (market_today() - timedelta(days=1)).isoformat()

    segment_mape: dict[str, float] = {}
    with closing(sqlite3.connect(DB_PATH)) as conn:
        for segment in SEGMENTS:
            df = pd.read_sql_query(
                """
                SELECT f.block, f.predicted_price, p.mcp
                FROM forecasts f
                JOIN price_history p
                  ON p.date = f.target_date AND p.segment = f.segment AND p.block = f.block
                WHERE f.target_date = ? AND f.segment = ?
                  AND f.id = (
                    SELECT MAX(f2.id) FROM forecasts f2
                    WHERE f2.target_date = f.target_date
                      AND f2.segment = f.segment
                      AND f2.block = f.block
                  )
                """,
                conn,
                params=(yesterday, segment),
            )
            mape = metrics.mape(df["mcp"], df["predicted_price"]) if len(df) else None
            if len(df) < _MIN_SCORED_BLOCKS or mape is None:
                logger.info(
                    "Feedback loop: %d scorable blocks for %s on %s, skipping",
                    len(df),
                    segment,
                    yesterday,
                )
                continue

            mape = round(mape, 4)
            segment_mape[segment] = mape
            triggered_retrain = mape > mape_threshold
            conn.execute(
                """
                INSERT INTO audit_log (session_id, user, action, entity_type, details, timestamp)
                VALUES (?, 'scheduler', 'feedback_loop', 'forecast', ?, CURRENT_TIMESTAMP)
                """,
                (
                    f"feedback-{yesterday}-{segment.lower()}",
                    json.dumps(
                        {
                            "date": yesterday,
                            "segment": segment,
                            "mape": mape,
                            "blocks_compared": len(df),
                            "threshold": mape_threshold,
                            "triggered_retrain": triggered_retrain,
                        }
                    ),
                ),
            )
            conn.commit()
            logger.info(
                "Feedback loop %s: MAPE=%.2f%% blocks=%d triggered_retrain=%s",
                segment,
                mape,
                len(df),
                triggered_retrain,
            )

    return segment_mape


def _run_pipeline_sync() -> None:
    from data.scrape_iex import scrape_date as scrape_iex_date
    from data.scrape_tam import fetch_tam_rsc
    from data.scrape_tam import records_to_rows as tam_records_to_rows
    from data.scrape_tam import store_rows as tam_store_rows

    lookback_days = max(1, _env_int("SCHEDULER_SCRAPE_LOOKBACK_DAYS", 1))
    tam_region = os.getenv("SCHEDULER_TAM_REGION", "NR").strip().upper() or "NR"
    retrain_enabled = _env_bool("SCHEDULER_RETRAIN_ENABLED", True)
    mape_threshold = _env_float("FEEDBACK_MAPE_THRESHOLD", 15.0)
    train_segments = [
        s.strip().upper()
        for s in os.getenv("SCHEDULER_TRAIN_SEGMENTS", ",".join(SEGMENTS)).split(",")
        if s.strip()
    ]

    end_date = market_today() - timedelta(days=1)
    start_date = end_date - timedelta(days=lookback_days - 1)
    logger.info(
        "Pipeline start: scrape %s..%s, retrain=%s segments=%s region=%s",
        start_date,
        end_date,
        retrain_enabled,
        train_segments,
        tam_region,
    )

    iex_inserted = 0
    current = start_date
    while current <= end_date:
        result = scrape_iex_date(current.isoformat(), ["DAM", "RTM"], DB_PATH)
        iex_inserted += sum(result.get(seg, {}).get("inserted", 0) for seg in ("DAM", "RTM"))
        current += timedelta(days=1)
    logger.info("DAM/RTM scrape done: inserted=%s", iex_inserted)

    # The TAM endpoint takes a date range, so one request covers the window.
    raw_tam = fetch_tam_rsc(start_date.isoformat(), end_date.isoformat(), contract_type="DAC")
    tam_rows = tam_records_to_rows(raw_tam, region=tam_region)
    tam_inserted = tam_store_rows(tam_rows, DB_PATH)
    logger.info(
        "TAM scrape done: raw=%s block_rows=%s inserted=%s",
        len(raw_tam),
        len(tam_rows),
        tam_inserted,
    )

    try:
        segment_mape = _feedback_loop_sync()
    except Exception:
        logger.exception("Feedback loop failed; continuing with the configured retrain policy")
        segment_mape = {}

    if retrain_enabled:
        segments_to_retrain = train_segments
    else:
        segments_to_retrain = [
            s for s in train_segments if segment_mape.get(s, 0.0) > mape_threshold
        ]
        if not segments_to_retrain:
            logger.info(
                "Retraining disabled and no segment above the %.1f%% MAPE threshold", mape_threshold
            )
            return
        logger.info(
            "Retraining disabled, but %s exceeded the %.1f%% MAPE threshold",
            segments_to_retrain,
            mape_threshold,
        )

    for segment in segments_to_retrain:
        try:
            m = _train_segment(segment)
            logger.info(
                "Retrained %s: MAPE=%s sMAPE=%s RMSE=%s",
                segment,
                m.get("mape"),
                m.get("smape"),
                m.get("rmse"),
            )
        except Exception:
            logger.exception("Retraining failed for segment=%s", segment)


def _run_enrichment_sync() -> None:
    """Enrich the last two days of price history with weather data from Open-Meteo."""
    from data.enrich_pipeline import run_enrichment

    if not _env_bool("SCHEDULER_ENRICHMENT_ENABLED", True):
        logger.info("Weather enrichment disabled by SCHEDULER_ENRICHMENT_ENABLED=false")
        return

    # ERA5 reanalysis lags about five days, so recent dates come from the Open-Meteo forecast API.
    today = market_today()
    try:
        result = run_enrichment(
            DB_PATH,
            start_date=(today - timedelta(days=2)).isoformat(),
            end_date=today.isoformat(),
        )
        weather = result.get("weather", {})
        logger.info(
            "Enrichment done: status=%s updated=%s skipped=%s errors=%s",
            result.get("status"),
            weather.get("updated", 0),
            weather.get("skipped", 0),
            weather.get("errors", []),
        )
    except Exception:
        logger.exception("Weather enrichment failed")


async def run_daily_pipeline() -> None:
    await asyncio.to_thread(_run_pipeline_sync)


async def run_daily_enrichment() -> None:
    await asyncio.to_thread(_run_enrichment_sync)


def start_scheduler() -> None:
    global scheduler

    if not _env_bool("SCHEDULER_ENABLED", False):
        logger.info("Scheduler disabled. Set SCHEDULER_ENABLED=true to enable.")
        return
    if scheduler and scheduler.running:
        return

    tz = _timezone()
    hour = _env_int("SCHEDULER_CRON_HOUR", 1)
    minute = _env_int("SCHEDULER_CRON_MINUTE", 10)
    # Enrichment runs 30 minutes after the scrape so the new price rows exist.
    enrich_hour = (hour + (minute + 30) // 60) % 24
    enrich_minute = (minute + 30) % 60

    scheduler = AsyncIOScheduler(timezone=tz)
    job_defaults = {
        "replace_existing": True,
        "max_instances": 1,
        "coalesce": True,
        "misfire_grace_time": 3600,
    }
    scheduler.add_job(
        run_daily_pipeline,
        CronTrigger(hour=hour, minute=minute, timezone=tz),
        id="daily-scrape-retrain",
        **job_defaults,
    )
    scheduler.add_job(
        run_daily_enrichment,
        CronTrigger(hour=enrich_hour, minute=enrich_minute, timezone=tz),
        id="daily-enrichment",
        **job_defaults,
    )
    scheduler.start()
    logger.info(
        "Scheduler started: scrape and retrain at %02d:%02d, enrichment at %02d:%02d (%s)",
        hour,
        minute,
        enrich_hour,
        enrich_minute,
        tz.key,
    )

    if _env_bool("SCHEDULER_RUN_ON_STARTUP", False):
        scheduler.add_job(run_daily_pipeline, id="startup-scrape-retrain", replace_existing=True)
        logger.info("Startup pipeline run scheduled (SCHEDULER_RUN_ON_STARTUP=true)")


def stop_scheduler() -> None:
    if scheduler and scheduler.running:
        scheduler.shutdown(wait=False)
        logger.info("Scheduler stopped")
