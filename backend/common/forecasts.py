"""Read access to stored forecasts shared by the bid, risk, approval and audit services."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Forecast


async def latest_forecasts(db: AsyncSession, target_date: str, segment: str) -> dict[int, Forecast]:
    """
    Return the most recent stored forecast for each block of a delivery date.

    Forecasts are appended on every prediction run, so a block can have several rows.
    The newest row (highest id) wins.
    """
    rows = (
        (
            await db.execute(
                select(Forecast)
                .where(Forecast.target_date == target_date, Forecast.segment == segment)
                .order_by(Forecast.id.desc())
            )
        )
        .scalars()
        .all()
    )
    latest: dict[int, Forecast] = {}
    for row in rows:
        latest.setdefault(row.block, row)
    return dict(sorted(latest.items()))


def as_optimizer_input(forecasts: dict[int, Forecast]) -> list[dict]:
    """Convert stored forecasts to the dicts consumed by the bid optimizer."""
    return [
        {
            "block": f.block,
            "predicted_price": f.predicted_price,
            "confidence_low": f.confidence_low,
            "confidence_high": f.confidence_high,
            "volatility": f.volatility,
        }
        for f in forecasts.values()
    ]
