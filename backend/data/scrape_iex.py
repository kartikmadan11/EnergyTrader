"""
Scrape real market data from IEX India via their REST API.

Discovered API: https://www.iexindia.com/api/v1/{segment}/market-snapshot
  - interval: ONE_FOURTH_HOUR (96 blocks/day) or DAILY
  - toDate / fromDate: DD-MM-YYYY format
  - Returns JSON: {statusCode, message, data: [{date, period, purchase_bid, sell_bid, mcv, final_scheduled_volume, mcp, congestion}]}

Usage (from backend/):
    uv run python -m data.scrape_iex --start 2025-01-01 --end 2026-03-30
"""

import argparse
import logging
import sqlite3
import time
from datetime import datetime, timedelta
from pathlib import Path

import requests

from common.config import DB_PATH
from common.http import requests_session

logger = logging.getLogger(__name__)

API_BASE = "https://www.iexindia.com/api/v1"

SEGMENT_ENDPOINTS = {
    "DAM": f"{API_BASE}/dam/market-snapshot",
    "RTM": f"{API_BASE}/rtm/market-snapshot",
}

SESSION = requests_session({"Content-Type": "application/json"})


def to_ddmmyyyy(iso_date: str) -> str:
    """Convert YYYY-MM-DD to DD-MM-YYYY."""
    d = datetime.strptime(iso_date, "%Y-%m-%d")
    return d.strftime("%d-%m-%Y")


def fetch_blocks(segment: str, date_str: str) -> list[dict]:
    """Fetch 96 fifteen-minute blocks for a segment and date via REST API."""
    url = SEGMENT_ENDPOINTS.get(segment)
    if not url:
        return []
    dd_mm_yyyy = to_ddmmyyyy(date_str)
    resp = SESSION.get(
        url,
        params={
            "interval": "ONE_FOURTH_HOUR",
            "fromDate": dd_mm_yyyy,
            "toDate": dd_mm_yyyy,
        },
        timeout=30,
    )
    resp.raise_for_status()
    body = resp.json()
    records = body.get("data", [])
    return records if isinstance(records, list) else []


def records_to_rows(records: list[dict], date_str: str, segment: str) -> list[dict]:
    """Convert IEX API records to DB schema rows."""
    rows = []
    for i, rec in enumerate(records):
        try:
            mcp_rsmwh = float(rec.get("mcp", 0))
            mcv_mw = float(rec.get("mcv", 0))
            purchase_bid = float(rec.get("purchase_bid", 0))
            sell_bid = float(rec.get("sell_bid", 0))
            rows.append(
                {
                    "date": date_str,
                    "block": i + 1,
                    "segment": segment,
                    "exchange": "IEX",
                    "mcp": round(mcp_rsmwh / 1000.0, 6),
                    "mcv": round(mcv_mw, 2),
                    "demand_mw": round(purchase_bid, 2),
                    "supply_mw": round(sell_bid, 2),
                    "renewable_gen_mw": None,
                    "temperature": None,
                }
            )
        except (ValueError, TypeError):
            continue
    return rows


def store_rows(rows: list[dict], db_path: Path) -> int:
    """Insert rows into SQLite, skipping duplicates."""
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    inserted = 0
    for r in rows:
        cur.execute(
            "SELECT COUNT(*) FROM price_history WHERE date=? AND block=? AND segment=?",
            (r["date"], r["block"], r["segment"]),
        )
        if cur.fetchone()[0] > 0:
            continue
        cur.execute(
            """INSERT INTO price_history
               (date, block, segment, exchange, mcp, mcv, demand_mw, supply_mw, renewable_gen_mw, temperature)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                r["date"],
                r["block"],
                r["segment"],
                r["exchange"],
                r["mcp"],
                r["mcv"],
                r["demand_mw"],
                r["supply_mw"],
                r["renewable_gen_mw"],
                r["temperature"],
            ),
        )
        inserted += 1
    conn.commit()
    conn.close()
    return inserted


def scrape_date(date_str: str, segments: list[str], db_path: Path) -> dict:
    """Scrape all requested segments for a single date."""
    results = {}
    for seg in segments:
        try:
            records = fetch_blocks(seg, date_str)
            if records:
                rows = records_to_rows(records, date_str, seg)
                count = store_rows(rows, db_path)
                results[seg] = {"scraped": len(rows), "inserted": count}
                logger.info("%s %s: %d blocks, %d new rows", seg, date_str, len(rows), count)
            else:
                results[seg] = {"scraped": 0, "inserted": 0}
                logger.info("%s %s: no data", seg, date_str)
        except requests.RequestException as e:
            results[seg] = {"scraped": 0, "inserted": 0, "error": str(e)}
            logger.warning("%s %s: HTTP error: %s", seg, date_str, e)
    return results


def date_range(start: str, end: str):
    s = datetime.strptime(start, "%Y-%m-%d")
    e = datetime.strptime(end, "%Y-%m-%d")
    while s <= e:
        yield s.strftime("%Y-%m-%d")
        s += timedelta(days=1)


def main():
    parser = argparse.ArgumentParser(description="Scrape IEX India market data via REST API")
    parser.add_argument("--start", required=True, help="Start date YYYY-MM-DD")
    parser.add_argument("--end", required=True, help="End date YYYY-MM-DD")
    parser.add_argument("--segments", default="DAM,RTM", help="Comma-separated: DAM,RTM")
    parser.add_argument("--db", default=str(DB_PATH), help="SQLite DB path")
    parser.add_argument("--delay", type=float, default=1.0, help="Delay between requests (sec)")
    args = parser.parse_args()

    segments = [s.strip().upper() for s in args.segments.split(",")]
    db_path = Path(args.db)
    dates = list(date_range(args.start, args.end))

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    logger.info("Scraping %d days x %d segments into %s", len(dates), len(segments), db_path)

    total = 0
    for i, d in enumerate(dates):
        results = scrape_date(d, segments, db_path)
        for res in results.values():
            total += res.get("inserted", 0)
        if i < len(dates) - 1:
            time.sleep(args.delay)

    logger.info("Inserted %d new rows", total)


if __name__ == "__main__":
    main()
