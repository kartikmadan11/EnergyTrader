import sqlite3
from contextlib import closing
from datetime import timedelta

import pytest

from common.config import DB_PATH, market_today
from common.models import Forecast, PriceHistory
from jobs import scheduler


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("true", True), (" YES ", True), ("1", True), ("on", True), ("false", False), ("0", False)],
)
def test_env_bool(monkeypatch, raw, expected):
    monkeypatch.setenv("SCHEDULER_FLAG", raw)
    assert scheduler._env_bool("SCHEDULER_FLAG", not expected) is expected


def test_env_numbers_fall_back_on_invalid_values(monkeypatch):
    monkeypatch.setenv("SCHEDULER_NUMBER", "soon")
    assert scheduler._env_int("SCHEDULER_NUMBER", 7) == 7
    assert scheduler._env_float("SCHEDULER_NUMBER", 1.5) == 1.5
    monkeypatch.delenv("SCHEDULER_NUMBER")
    assert scheduler._env_bool("SCHEDULER_NUMBER", True) is True


def _forecasts(day: str, segment: str, price: float, blocks: range) -> list[Forecast]:
    return [
        Forecast(target_date=day, block=b, segment=segment, predicted_price=price) for b in blocks
    ]


def _actuals(day: str, segment: str, mcp: float, blocks: range) -> list[PriceHistory]:
    return [PriceHistory(date=day, block=b, segment=segment, mcp=mcp) for b in blocks]


def test_feedback_loop_scores_the_latest_forecast_and_audits_it(client, seed):
    yesterday = (market_today() - timedelta(days=1)).isoformat()
    dam, rtm = range(1, 97), range(1, 5)  # RTM has too few blocks to score
    seed(
        *_actuals(yesterday, "DAM", 4.0, dam),
        *_actuals(yesterday, "RTM", 4.0, rtm),
        # A stale run that is far off, then the run that should be scored: 10% high everywhere.
        *_forecasts(yesterday, "DAM", 8.0, dam),
        *_forecasts(yesterday, "DAM", 4.4, dam),
        *_forecasts(yesterday, "RTM", 4.0, rtm),
    )

    result = scheduler._feedback_loop_sync()

    assert result == {"DAM": pytest.approx(10.0)}
    with closing(sqlite3.connect(DB_PATH)) as conn:
        rows = conn.execute(
            "SELECT session_id, user FROM audit_log WHERE action = 'feedback_loop'"
        ).fetchall()
    assert rows == [(f"feedback-{yesterday}-dam", "scheduler")]
