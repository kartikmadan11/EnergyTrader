import os
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from sqlalchemy.engine import make_url

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite+aiosqlite:///{DATA_DIR / 'platform.db'}")
# Scrapers and the scheduler open the same SQLite file synchronously.
DB_PATH = Path(make_url(DATABASE_URL).database)

# DSM regulation parameters live in data/policies/*.yaml (see common/dsm_policy.py).

# Market segments
SEGMENTS = ["DAM", "RTM", "TAM"]

# 96 time blocks of 15 minutes, 00:00-23:45 IST
NUM_BLOCKS = 96
BLOCK_DURATION_MIN = 15

# Exchange delivery dates are IST dates.
MARKET_TZ = ZoneInfo("Asia/Kolkata")


def market_today() -> date:
    """Today's date in IST, independent of the host clock's timezone."""
    return datetime.now(MARKET_TZ).date()


# Strategy multipliers (affect bid aggressiveness)
STRATEGY_PROFILES = {
    "conservative": {"price_offset": -0.8, "volume_scale": 0.85, "risk_tolerance": 0.3},
    "balanced": {"price_offset": 0.0, "volume_scale": 1.00, "risk_tolerance": 0.6},
    "aggressive": {"price_offset": 0.6, "volume_scale": 1.15, "risk_tolerance": 0.9},
}
