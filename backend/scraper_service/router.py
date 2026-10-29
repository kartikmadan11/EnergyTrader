"""
Market data ingestion endpoints.

  POST /scraper/trigger        scrape one segment for a date window
  POST /scraper/trigger-all    scrape every segment for the last N days
  GET  /scraper/status         coverage per segment
  POST /scraper/enrich         backfill weather features in the background
  GET  /scraper/enrich/status  rows still missing weather features
"""

import asyncio
import logging
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func as sql_func
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from common.config import DB_PATH, SEGMENTS, market_today
from common.database import get_db
from common.models import PriceHistory

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/scraper", tags=["Scraper"])


def _run_scrape_sync(segment: str, start: date, end: date) -> dict:
    """Scrape one segment for [start, end]. Blocking, so callers run it in a thread."""
    date_range = [(start + timedelta(days=i)).isoformat() for i in range((end - start).days + 1)]
    total: dict = {"scraped": 0, "inserted": 0, "dates": [], "errors": []}

    if segment in ("DAM", "RTM"):
        from data.scrape_iex import scrape_date

        for d in date_range:
            try:
                seg = scrape_date(d, [segment], DB_PATH).get(segment, {})
            except Exception as exc:
                logger.warning("Scrape failed for %s %s: %s", segment, d, exc)
                total["errors"].append(f"{d}: {exc}")
                continue
            if "error" in seg:
                total["errors"].append(f"{d}: {seg['error']}")
            total["scraped"] += seg.get("scraped", 0)
            total["inserted"] += seg.get("inserted", 0)
            if seg.get("scraped", 0) > 0:
                total["dates"].append(d)

    elif segment == "TAM":
        from data.scrape_tam import fetch_tam_rsc, records_to_rows, store_rows

        try:
            rows = records_to_rows(
                fetch_tam_rsc(start.isoformat(), end.isoformat(), contract_type="DAC")
            )
            total["inserted"] = store_rows(rows, DB_PATH)
            total["scraped"] = len(rows)
            total["dates"] = sorted({r["date"] for r in rows})
        except Exception as exc:
            logger.warning("TAM scrape failed for %s..%s: %s", start, end, exc)
            total["errors"].append(str(exc))

    return total


@router.post("/trigger")
async def trigger_scrape(
    segment: str = Query(..., pattern=r"^(DAM|RTM|TAM)$", description="Market segment to scrape"),
    days: int = Query(default=3, ge=1, le=30, description="Number of days back from today (IST)"),
    start_date: str | None = Query(
        default=None,
        pattern=r"^\d{4}-\d{2}-\d{2}$",
        description="Explicit start date YYYY-MM-DD (overrides `days`)",
    ),
    end_date: str | None = Query(
        default=None,
        pattern=r"^\d{4}-\d{2}-\d{2}$",
        description="Explicit end date YYYY-MM-DD (defaults to today, IST)",
    ),
):
    """
    Scrape one segment from IEX for a rolling window or an explicit range of up to 30 days.

    Rows already in the database are skipped, so repeated calls are safe.
    """
    today = market_today()
    if start_date:
        try:
            start = date.fromisoformat(start_date)
            end = date.fromisoformat(end_date) if end_date else today
        except ValueError as exc:
            raise HTTPException(422, "Invalid date") from exc
        if end < start:
            raise HTTPException(422, "end_date must be >= start_date")
        if (end - start).days > 29:
            raise HTTPException(422, "Date range cannot exceed 30 days")
    else:
        end = today
        start = end - timedelta(days=days - 1)

    result = await asyncio.to_thread(_run_scrape_sync, segment, start, end)
    if result["errors"] and not result["dates"]:
        raise HTTPException(502, result["errors"][0])

    return {
        "status": "ok",
        "segment": segment,
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "scraped": result["scraped"],
        "inserted": result["inserted"],
        "dates_with_data": result["dates"],
        "errors": result["errors"],
    }


@router.post("/trigger-all")
async def trigger_scrape_all(
    days: int = Query(default=3, ge=1, le=30, description="Number of days back from today (IST)"),
):
    """Scrape DAM, RTM and TAM concurrently and return a per-segment result."""
    end = market_today()
    start = end - timedelta(days=days - 1)
    results = await asyncio.gather(
        *(asyncio.to_thread(_run_scrape_sync, seg, start, end) for seg in SEGMENTS)
    )
    return {
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "segments": {
            seg: {
                "status": "error" if r["errors"] and not r["dates"] else "ok",
                "scraped": r["scraped"],
                "inserted": r["inserted"],
                "dates_with_data": r["dates"],
                "errors": r["errors"],
            }
            for seg, r in zip(SEGMENTS, results, strict=True)
        },
    }


@router.get("/status")
async def scrape_status(db: AsyncSession = Depends(get_db)):
    """Earliest and latest date and row count per segment."""
    status: dict = {"segments": {}}
    for seg in SEGMENTS:
        row = (
            await db.execute(
                select(
                    sql_func.max(PriceHistory.date).label("latest_date"),
                    sql_func.min(PriceHistory.date).label("earliest_date"),
                    sql_func.count(PriceHistory.id).label("row_count"),
                ).where(PriceHistory.segment == seg)
            )
        ).one()
        status["segments"][seg] = {
            "latest_date": row.latest_date,
            "earliest_date": row.earliest_date,
            "row_count": row.row_count,
        }
    return status


@router.post("/enrich")
async def trigger_enrichment(
    start_date: str | None = Query(
        default=None,
        pattern=r"^\d{4}-\d{2}-\d{2}$",
        description="Start date (YYYY-MM-DD). Detected from unenriched rows if omitted.",
    ),
    end_date: str | None = Query(
        default=None,
        pattern=r"^\d{4}-\d{2}-\d{2}$",
        description="End date (YYYY-MM-DD). Defaults to today if omitted.",
    ),
    overwrite: bool = Query(
        default=False, description="Re-enrich rows that already have weather data."
    ),
):
    """
    Backfill weather features on price history from Open-Meteo.

    Populates temperature (ERA5 reanalysis), wind_speed_ms, solar_radiation_wm2 and
    cloud_cover_pct.
    Only empty rows are filled unless overwrite=true.
    Runs in the background; poll GET /scraper/enrich/status for progress.
    """
    from data.enrich_pipeline import run_enrichment

    def _run() -> None:
        try:
            result = run_enrichment(
                db_path=DB_PATH, start_date=start_date, end_date=end_date, overwrite=overwrite
            )
            logger.info("Background enrichment complete: %s", result)
        except Exception:
            logger.exception("Background enrichment failed")

    asyncio.get_running_loop().run_in_executor(None, _run)
    return {
        "status": "started",
        "params": {"start_date": start_date, "end_date": end_date, "overwrite": overwrite},
    }


@router.get("/enrich/status")
async def enrichment_status():
    """How many price history rows are still missing weather features."""
    from data.enrich_pipeline import get_unenriched_date_range, unenriched_row_count
    from data.scrape_weather import ensure_weather_columns

    ensure_weather_columns(DB_PATH)
    earliest, latest = get_unenriched_date_range(DB_PATH)
    return {
        "unenriched_rows": unenriched_row_count(DB_PATH),
        "date_range": {"earliest": earliest, "latest": latest},
    }
