"""
Unified feature enrichment pipeline.

Orchestrates all non-IEX data sources:
  1. Open-Meteo weather  - temperature, wind speed, solar radiation, cloud cover
  2. India public holidays - computed in-memory from the `holidays` package
     (no external API, purely deterministic), returned as helper functions
     used by model._build_features().

Entry points:
  run_enrichment(db_path, start_date, end_date)   ← called by router + scheduler
  get_unenriched_date_range(db_path)               ← auto-detect missing dates
  compute_holiday_features(dates_series)           ← used in _build_features

Holiday coverage (holidays.India()):
  National: Republic Day, Holi, Good Friday, Independence Day, Gandhi Jayanti,
            Diwali, Dussehra, Christmas, etc.
  Note: state-level holidays vary; only national ones affect IEX as a whole.
"""

import bisect
import logging
import sqlite3
from datetime import date
from pathlib import Path

import pandas as pd

logger = logging.getLogger(__name__)


# ── Holiday helpers ───────────────────────────────────────────────────────────

# ── Embedded India national holiday lookup (no external package needed) ──────
_INDIA_HOLIDAYS_FIXED: dict[str, str] = {
    "2024-01-26": "Republic Day",
    "2024-03-25": "Holi",
    "2024-03-29": "Good Friday",
    "2024-04-14": "Dr Ambedkar Jayanti",
    "2024-08-15": "Independence Day",
    "2024-10-02": "Gandhi Jayanti",
    "2024-11-01": "Diwali",
    "2024-11-15": "Guru Nanak Jayanti",
    "2024-12-25": "Christmas",
    "2025-01-01": "New Year",
    "2025-01-26": "Republic Day",
    "2025-03-14": "Holi",
    "2025-04-14": "Dr Ambedkar Jayanti",
    "2025-04-18": "Good Friday",
    "2025-08-15": "Independence Day",
    "2025-10-02": "Gandhi Jayanti",
    "2025-10-20": "Diwali",
    "2025-11-05": "Guru Nanak Jayanti",
    "2025-12-25": "Christmas",
    "2026-01-01": "New Year",
    "2026-01-26": "Republic Day",
    "2026-03-03": "Holi",
    "2026-04-03": "Good Friday",
    "2026-04-14": "Dr Ambedkar Jayanti",
    "2026-08-15": "Independence Day",
    "2026-10-02": "Gandhi Jayanti",
    "2026-10-19": "Dussehra",
    "2026-11-08": "Diwali",
    "2026-11-24": "Guru Nanak Jayanti",
    "2026-12-25": "Christmas",
    "2027-01-01": "New Year",
    "2027-01-26": "Republic Day",
    "2027-03-22": "Holi",
    "2027-03-26": "Good Friday",
    "2027-04-14": "Dr Ambedkar Jayanti",
    "2027-08-15": "Independence Day",
    "2027-10-02": "Gandhi Jayanti",
    "2027-10-08": "Dussehra",
    "2027-10-29": "Diwali",
    "2027-11-14": "Guru Nanak Jayanti",
    "2027-12-25": "Christmas",
}


def _build_india_holiday_set(year_min: int, year_max: int) -> list[date]:
    """Return sorted list of Indian national holiday dates for [year_min, year_max+1]."""
    try:
        import holidays as holidays_lib

        h = holidays_lib.India(years=range(year_min, year_max + 2))
        return sorted(h.keys())
    except ImportError:
        pass
    result: list[date] = []
    for d_str in _INDIA_HOLIDAYS_FIXED:
        d = date.fromisoformat(d_str)
        if year_min <= d.year <= year_max + 1:
            result.append(d)
    return sorted(set(result))


def compute_holiday_features(
    dates_series: pd.Series,
) -> tuple[pd.Series, pd.Series]:
    """
    Given a pandas Series of date-like values (strings or date objects),
    return two Series aligned to the same index:
      is_holiday     : int  0/1 - is this date an Indian national holiday?
      days_to_holiday: int  signed days to nearest holiday, clamped to [-7, +7]
                            negative = holiday was N days ago
                            positive = holiday is N days ahead
                            0 = today IS a holiday

    Usage in _build_features:
        df["is_holiday"], df["days_to_holiday"] = compute_holiday_features(df["datetime"])
    """
    # Normalise to date objects
    dates = pd.to_datetime(dates_series).dt.date

    if dates.empty:
        empty = pd.Series(0, index=dates_series.index)
        return empty, empty

    year_min = min(d.year for d in dates)
    year_max = max(d.year for d in dates)
    holiday_list = _build_india_holiday_set(year_min, year_max)

    if not holiday_list:
        zero = pd.Series(0, index=dates_series.index)
        return zero, zero

    holiday_set = set(holiday_list)

    def _days_to_nearest(d: date) -> int:
        idx = bisect.bisect_left(holiday_list, d)
        candidates: list[int] = []
        if idx < len(holiday_list):
            candidates.append((holiday_list[idx] - d).days)
        if idx > 0:
            candidates.append((holiday_list[idx - 1] - d).days)
        if not candidates:
            return 7
        return min(candidates, key=abs)

    is_holiday = pd.Series([int(d in holiday_set) for d in dates], index=dates_series.index)
    days_to_holiday = pd.Series(
        [_days_to_nearest(d) for d in dates], index=dates_series.index
    ).clip(-7, 7)

    return is_holiday, days_to_holiday


# ── Pipeline ─────────────────────────────────────────────────────────────────


def get_unenriched_date_range(db_path: Path) -> tuple[str | None, str | None]:
    """
    Return (start_date, end_date) of price_history rows that are missing
    weather data (wind_speed_ms IS NULL).
    Returns (None, None) if all rows are enriched or table is empty.
    """
    from data.scrape_weather import ensure_weather_columns

    ensure_weather_columns(db_path)

    conn = sqlite3.connect(db_path, timeout=30)
    try:
        row = conn.execute(
            "SELECT MIN(date), MAX(date) FROM price_history WHERE wind_speed_ms IS NULL"
        ).fetchone()
        return (row[0], row[1]) if row and row[0] else (None, None)
    finally:
        conn.close()


def unenriched_row_count(db_path: Path) -> int:
    """Count price_history rows that still need weather enrichment."""
    conn = sqlite3.connect(db_path, timeout=30)
    try:
        row = conn.execute(
            "SELECT COUNT(*) FROM price_history WHERE wind_speed_ms IS NULL"
        ).fetchone()
        return row[0] if row else 0
    finally:
        conn.close()


def run_enrichment(
    db_path: Path,
    start_date: str | None = None,
    end_date: str | None = None,
    overwrite: bool = False,
    lat: float = 28.67,  # Delhi NCR
    lon: float = 77.22,
) -> dict:
    """
    Run the full enrichment pipeline for [start_date, end_date]:
      - If dates not provided, auto-detects range from unenriched rows.
      - Fetches Open-Meteo weather and writes into price_history.
      - Holiday features are always computed at model._build_features() time
        (they're deterministic, no DB storage needed).

    Returns summary dict:
        {
          "status": "ok" | "no_op",
          "start_date": str,
          "end_date": str,
          "weather": {"updated": int, "skipped": int, "errors": list}
        }
    """
    from data.scrape_weather import enrich_price_history

    # Auto-detect range if not supplied
    if not start_date or not end_date:
        auto_start, auto_end = get_unenriched_date_range(db_path)
        if not auto_start:
            return {
                "status": "no_op",
                "message": "All rows already have weather data",
                "weather": {"updated": 0, "skipped": 0, "errors": []},
            }
        start_date = start_date or auto_start
        end_date = end_date or min(auto_end, date.today().isoformat())

    logger.info("Enrichment pipeline: weather for %s → %s", start_date, end_date)

    weather_result = enrich_price_history(
        db_path=db_path,
        start_date=start_date,
        end_date=end_date,
        lat=lat,
        lon=lon,
        overwrite=overwrite,
    )

    return {
        "status": "ok",
        "start_date": start_date,
        "end_date": end_date,
        "weather": weather_result,
    }
