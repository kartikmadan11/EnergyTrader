"""
Scrape TAM (Term Ahead Market) trade-details from IEX India via RSC endpoint.

Unlike DAM/RTM which use /api/v1/{segment}/market-snapshot, TAM data is only
available via the Next.js RSC (React Server Components) endpoint:
  https://www.iexindia.com/market-data/intra-day-ahead-contingency/trade-details

Query params: reportType, dp, contractType, toDate, fromDate, solarType
Returns tableData with per-block, per-region, per-contract-type trade records.

We extract DAC (Day Ahead Contingency) contract records for block-level data
comparable to DAM/RTM 96-block market snapshots.

Usage (from backend/):
    uv run python -m data.scrape_tam --start 2025-10-01 --end 2026-03-30
"""

import argparse
import json
import logging
import re
import sqlite3
import time
from datetime import datetime, timedelta
from pathlib import Path

from common.config import DB_PATH
from common.http import requests_session

logger = logging.getLogger(__name__)

RSC_URL = "https://www.iexindia.com/market-data/intra-day-ahead-contingency/trade-details"
RSC_HEADERS = {
    "RSC": "1",
    "Next-Url": "/en/market-data/intra-day-ahead-contingency/trade-details",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
}

SESSION = requests_session()


def to_ddmmyyyy(iso_date: str) -> str:
    d = datetime.strptime(iso_date, "%Y-%m-%d")
    return d.strftime("%d-%m-%Y")


def fetch_tam_rsc(from_date: str, to_date: str, contract_type: str = "ALL") -> list[dict]:
    """Fetch TAM trade-details via RSC for a date range."""
    params = {
        "reportType": "TRADE_DATE_WISE",
        "dp": "SELECT_RANGE",
        "contractType": contract_type,
        "fromDate": to_ddmmyyyy(from_date),
        "toDate": to_ddmmyyyy(to_date),
        "solarType": "",
    }
    resp = SESSION.get(RSC_URL, params=params, headers=RSC_HEADERS, timeout=60)
    resp.raise_for_status()
    text = resp.text

    # Extract tableData JSON array from RSC payload
    idx = text.find('"tableData":')
    if idx == -1:
        return []

    bracket_start = text.index("[", idx)
    depth = 0
    end_pos = None
    for i in range(bracket_start, len(text)):
        if text[i] == "[":
            depth += 1
        elif text[i] == "]":
            depth -= 1
        if depth == 0:
            end_pos = i
            break

    if end_pos is None:
        return []

    data_str = text[bracket_start : end_pos + 1]
    return json.loads(data_str)


def parse_instrument(instrument_name: str):
    """Parse instrument name like 'DAC-B26-NR' into block and region.

    Formats:
      DAC-B{block}-{region}   -> DAC contract, block 1-96, region NR/SR/ER/WR
      B{block}-{day}-{region} -> DAILY contract (day of week)
      INTRA-B{block}-{region} -> INTRADAY contract
    """
    # DAC format: DAC-B01-NR
    m = re.match(r"DAC-B(\d+)-(\w+)", instrument_name)
    if m:
        return {"block": int(m.group(1)), "region": m.group(2), "contract": "DAC"}

    # DAILY format: B10-FRI-NR
    m = re.match(r"B(\d+)-(?:MON|TUE|WED|THU|FRI|SAT|SUN)-(\w+)", instrument_name)
    if m:
        return {"block": int(m.group(1)), "region": m.group(2), "contract": "DAILY"}

    # INTRADAY format
    m = re.match(r"INTRA-B(\d+)-(\w+)", instrument_name)
    if m:
        return {"block": int(m.group(1)), "region": m.group(2), "contract": "INTRADAY"}

    return None


def convert_date(dd_mm_yyyy: str) -> str:
    """Convert DD-MM-YYYY to YYYY-MM-DD."""
    d = datetime.strptime(dd_mm_yyyy, "%d-%m-%Y")
    return d.strftime("%Y-%m-%d")


def records_to_rows(records: list[dict], region: str = "NR") -> list[dict]:
    """Convert TAM trade-details records to DB rows.

    Filters to DAC contract type and specified region for 96-block comparable data.
    Price is in Rs/MWh from the API; we convert to INR/kWh (divide by 1000).
    """
    # Group records by (date, block) to aggregate across trades
    block_data = {}

    for rec in records:
        instrument = rec.get("instrumentName", "")
        parsed = parse_instrument(instrument)
        if parsed is None:
            continue
        if parsed["contract"] != "DAC":
            continue
        if parsed["region"] != region:
            continue

        trade_date = convert_date(rec["tradeDate"])
        block = parsed["block"]
        key = (trade_date, block)

        price_rsmwh = float(rec.get("weightedAveragePrice", 0) or 0)
        volume = float(rec.get("totalTradedVolume", 0) or 0)
        buy_vol = float(rec.get("totalBuyBidVolume", 0) or 0)
        sell_vol = float(rec.get("totalSellBidVolume", 0) or 0)

        if key not in block_data:
            block_data[key] = {
                "date": trade_date,
                "block": block,
                "segment": "TAM",
                "exchange": "IEX",
                "mcp": price_rsmwh,
                "mcv": volume,
                "demand_mw": buy_vol,
                "supply_mw": sell_vol,
                "renewable_gen_mw": None,
                "temperature": None,
            }
        else:
            # Aggregate: weighted average price, sum volumes
            existing = block_data[key]
            old_vol = existing["mcv"]
            new_vol = old_vol + volume
            if new_vol > 0:
                existing["mcp"] = (existing["mcp"] * old_vol + price_rsmwh * volume) / new_vol
            existing["mcv"] = new_vol
            existing["demand_mw"] += buy_vol
            existing["supply_mw"] += sell_vol

    # Convert prices from Rs/MWh to INR/kWh and return sorted rows
    rows = []
    for row in block_data.values():
        row["mcp"] = round(row["mcp"] / 1000.0, 6)
        row["mcv"] = round(row["mcv"], 2)
        row["demand_mw"] = round(row["demand_mw"], 2)
        row["supply_mw"] = round(row["supply_mw"], 2)
        rows.append(row)

    rows.sort(key=lambda r: (r["date"], r["block"]))
    return rows


def store_rows(rows: list[dict], db_path: Path) -> int:
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


def month_ranges(start: str, end: str):
    """Yield (start, end) pairs for each calendar month in the range."""
    s = datetime.strptime(start, "%Y-%m-%d")
    e = datetime.strptime(end, "%Y-%m-%d")
    while s <= e:
        month_end = (s.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
        if month_end > e:
            month_end = e
        yield s.strftime("%Y-%m-%d"), month_end.strftime("%Y-%m-%d")
        s = month_end + timedelta(days=1)


def main():
    parser = argparse.ArgumentParser(description="Scrape TAM trade-details from IEX via RSC")
    parser.add_argument("--start", required=True, help="Start date YYYY-MM-DD")
    parser.add_argument("--end", required=True, help="End date YYYY-MM-DD")
    parser.add_argument("--region", default="NR", help="Region filter: NR, SR, ER, WR (default NR)")
    parser.add_argument("--db", default=str(DB_PATH), help="SQLite DB path")
    parser.add_argument(
        "--delay", type=float, default=2.0, help="Delay between month requests (sec)"
    )
    args = parser.parse_args()

    db_path = Path(args.db)
    months = list(month_ranges(args.start, args.end))

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    logger.info(
        "Scraping TAM (DAC) trade details for %d months, region=%s, into %s",
        len(months),
        args.region,
        db_path,
    )

    total_records = 0
    total_inserted = 0

    for i, (m_start, m_end) in enumerate(months):
        try:
            raw = fetch_tam_rsc(m_start, m_end, contract_type="DAC")
            rows = records_to_rows(raw, region=args.region)
            inserted = store_rows(rows, db_path)
            total_records += len(rows)
            total_inserted += inserted
            dates = set(r["date"] for r in rows)
            blocks_per_day = len(rows) / len(dates) if dates else 0
            logger.info(
                "[%d/%d] %s to %s: %d raw -> %d blocks (%d days, ~%.0f blocks/day), %d new",
                i + 1,
                len(months),
                m_start,
                m_end,
                len(raw),
                len(rows),
                len(dates),
                blocks_per_day,
                inserted,
            )
        except Exception as e:
            logger.error("[%d/%d] %s to %s failed: %s", i + 1, len(months), m_start, m_end, e)

        if i < len(months) - 1:
            time.sleep(args.delay)

    logger.info("%d block rows, %d newly inserted", total_records, total_inserted)


if __name__ == "__main__":
    main()
