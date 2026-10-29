"""
Fetch hourly weather data from Open-Meteo (free, no API key required) and
map to IEX 96-block (15-minute) resolution.

Primary location: Delhi NCR (28.67°N, 77.22°E) - India's largest load dispatch
center and the dominant driver of IEX DAM price formation. The pipeline supports
multiple locations; add entries to LOCATIONS and call fetch_multi_location() to
get a per-block average across grid points.

Variables fetched:
  temperature_2m        °C    → overwrites sparse scraped `temperature` column
  wind_speed_10m        m/s   → wind_speed_ms  (wind generation proxy)
  shortwave_radiation   W/m²  → solar_radiation_wm2 (solar noon collapse signal)
  cloud_cover           %     → cloud_cover_pct (sky obscuration)

API endpoints:
  Archive  (ERA5/IFS, back to 1940, 5-day delay):  archive-api.open-meteo.com
  Forecast (IFS, up to D+16):                       api.open-meteo.com

Both are free for non-commercial / research use with no API key.
"""

import logging
import sqlite3
from datetime import date, timedelta
from pathlib import Path

import httpx

from common.http import tls_context

logger = logging.getLogger(__name__)

# ── India grid coordinates ────────────────────────────────────────────────────
# Extend this dict to enable multi-location averaging (see fetch_multi_location).
LOCATIONS: dict[str, dict] = {
    "delhi": {"lat": 28.67, "lon": 77.22},  # Northern grid, ~28% national load
    "mumbai": {"lat": 19.08, "lon": 72.88},  # Western grid
    "chennai": {"lat": 13.08, "lon": 80.27},  # Southern grid, major solar/wind
}
DEFAULT_LAT = 28.67
DEFAULT_LON = 77.22

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
HOURLY_VARS = "temperature_2m,wind_speed_10m,shortwave_radiation,cloud_cover"

# ERA5 reanalysis has ~5-day lag; use the forecast API for more recent dates.
ARCHIVE_DELAY_DAYS = 6


# ── Core fetch ────────────────────────────────────────────────────────────────


def fetch_weather_hourly(
    start_date: str,
    end_date: str,
    lat: float = DEFAULT_LAT,
    lon: float = DEFAULT_LON,
    timeout: int = 30,
) -> dict[str, dict[int, dict]]:
    """
    Fetch hourly weather for [start_date, end_date] at (lat, lon).

    Returns:
        {
          "2025-10-01": {
              0: {"temperature_2m": 22.3, "wind_speed_ms": 3.1,
                  "solar_radiation_wm2": 0.0, "cloud_cover_pct": 20.0},
              1: { ... },
              ...
              23: { ... }
          },
          "2025-10-02": { ... },
          ...
        }
    """
    start = date.fromisoformat(start_date)
    end = date.fromisoformat(end_date)
    cutoff = date.today() - timedelta(days=ARCHIVE_DELAY_DAYS)

    archive_end = min(end, cutoff)
    forecast_start = max(start, cutoff + timedelta(days=1))

    hourly_data: dict[str, dict[int, dict]] = {}

    def _fetch(url: str, s: str, e: str) -> None:
        params = {
            "latitude": lat,
            "longitude": lon,
            "start_date": s,
            "end_date": e,
            "hourly": HOURLY_VARS,
            "wind_speed_unit": "ms",
            "timezone": "Asia/Kolkata",
        }
        resp = httpx.get(url, params=params, timeout=timeout, verify=tls_context())
        resp.raise_for_status()
        data = resp.json()

        times = data["hourly"]["time"]  # "2025-10-01T00:00" …
        temps = data["hourly"]["temperature_2m"]
        winds = data["hourly"]["wind_speed_10m"]
        solar = data["hourly"]["shortwave_radiation"]
        cloud = data["hourly"]["cloud_cover"]

        for i, t in enumerate(times):
            d_str, h_str = t.split("T")
            hour = int(h_str[:2])
            if d_str not in hourly_data:
                hourly_data[d_str] = {}
            hourly_data[d_str][hour] = {
                "temperature_2m": temps[i],
                "wind_speed_ms": winds[i],
                "solar_radiation_wm2": solar[i],
                "cloud_cover_pct": cloud[i],
            }

    if start <= archive_end:
        _fetch(ARCHIVE_URL, start.isoformat(), archive_end.isoformat())

    if forecast_start <= end:
        _fetch(FORECAST_URL, forecast_start.isoformat(), end.isoformat())

    return hourly_data


def blocks_for_date(hourly: dict[str, dict[int, dict]], date_str: str) -> list[dict]:
    """
    Map an hourly weather dict to all 96 IEX blocks for `date_str`.

    Block → hour mapping:  blocks 1-4 → hour 0, blocks 5-8 → hour 1, …
    Returns a list of 96 dicts (block 1-indexed).
    """
    day = hourly.get(date_str, {})
    rows = []
    for block in range(1, 97):
        hour = (block - 1) // 4
        w = day.get(hour, {})
        rows.append(
            {
                "block": block,
                "temperature_2m": w.get("temperature_2m"),
                "wind_speed_ms": w.get("wind_speed_ms"),
                "solar_radiation_wm2": w.get("solar_radiation_wm2"),
                "cloud_cover_pct": w.get("cloud_cover_pct"),
            }
        )
    return rows


# ── DB helpers ────────────────────────────────────────────────────────────────


def ensure_weather_columns(db_path: Path) -> None:
    """
    Add weather columns to price_history if they don't exist.
    SQLite doesn't support `ADD COLUMN IF NOT EXISTS`; we catch the error.
    """
    additions = [
        ("wind_speed_ms", "REAL"),
        ("solar_radiation_wm2", "REAL"),
        ("cloud_cover_pct", "REAL"),
    ]
    conn = sqlite3.connect(db_path, timeout=120)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=120000")
    try:
        for col, typ in additions:
            try:
                conn.execute(f"ALTER TABLE price_history ADD COLUMN {col} {typ}")
                logger.info("Added column price_history.%s", col)
            except sqlite3.OperationalError:
                pass  # column already exists
        conn.commit()
    finally:
        conn.close()


def enrich_price_history(
    db_path: Path,
    start_date: str,
    end_date: str,
    lat: float = DEFAULT_LAT,
    lon: float = DEFAULT_LON,
    overwrite: bool = False,
    timeout: int = 30,
) -> dict:
    """
    Fetch weather for [start_date, end_date] and write into price_history rows.

    By default only updates rows where wind_speed_ms IS NULL.
    Set overwrite=True to refresh already-enriched rows.

    Returns:
        {"updated": int, "skipped": int, "errors": list[str]}
    """
    ensure_weather_columns(db_path)

    try:
        hourly = fetch_weather_hourly(start_date, end_date, lat=lat, lon=lon, timeout=timeout)
    except Exception as exc:
        logger.exception("Weather fetch failed")
        return {"updated": 0, "skipped": 0, "errors": [str(exc)]}

    updated = skipped = 0
    errors: list[str] = []

    conn = sqlite3.connect(db_path, timeout=120)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=120000")
    try:
        cursor = conn.cursor()

        for date_str, hours in hourly.items():
            for block in range(1, 97):
                hour = (block - 1) // 4
                w = hours.get(hour)
                if not w:
                    skipped += 1
                    continue

                if not overwrite:
                    # Check if ANY row for (date, block) is unenriched across ALL segments.
                    # Without a segment filter the old check returned a single row
                    # (e.g. TAM:OK) and skipped the block even when DAM:NULL existed.
                    cursor.execute(
                        "SELECT COUNT(*) FROM price_history WHERE date=? AND block=? AND wind_speed_ms IS NULL",
                        (date_str, block),
                    )
                    if cursor.fetchone()[0] == 0:
                        # All segments already enriched (or no rows exist)
                        skipped += 1
                        continue

                # UPDATE only unenriched rows so already-enriched segments are untouched.
                cursor.execute(
                    """
                    UPDATE price_history
                       SET temperature        = ?,
                           wind_speed_ms      = ?,
                           solar_radiation_wm2 = ?,
                           cloud_cover_pct    = ?
                     WHERE date = ? AND block = ?
                       AND wind_speed_ms IS NULL
                    """,
                    (
                        w.get("temperature_2m"),
                        w.get("wind_speed_ms"),
                        w.get("solar_radiation_wm2"),
                        w.get("cloud_cover_pct"),
                        date_str,
                        block,
                    ),
                )
                if cursor.rowcount > 0:
                    updated += 1
                else:
                    skipped += 1

            # Commit after each date to keep write transactions short
            # and release the WAL write lock quickly.
            conn.commit()

    except Exception as exc:
        errors.append(str(exc))
        logger.exception("DB write error during weather enrichment")
    finally:
        conn.close()

    logger.info(
        "Weather enrichment complete: updated=%d skipped=%d errors=%d",
        updated,
        skipped,
        len(errors),
    )
    return {"updated": updated, "skipped": skipped, "errors": errors}


# ── Forecast weather for predict() ───────────────────────────────────────────


def fetch_forecast_for_date(
    target_date: str,
    lat: float = DEFAULT_LAT,
    lon: float = DEFAULT_LON,
    timeout: int = 15,
) -> dict[int, dict]:
    """
    Fetch Open-Meteo weather forecast for a single future/today date.
    Returns {hour (0-23): {weather dict}} suitable for use in model.predict().
    Automatically picks archive vs forecast URL based on date age.
    """
    hourly = fetch_weather_hourly(target_date, target_date, lat=lat, lon=lon, timeout=timeout)
    return hourly.get(target_date, {})
