"""
Server-side evaluation of a bid set, shared by pre-trade checks and submission.

Nothing the client sends about constraint violations or risk is trusted:
constraints are re-validated against the active DSM policy, risk is recomputed from
the stored forecasts for the delivery date, and the checks run on those results.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence

from sqlalchemy.ext.asyncio import AsyncSession

from bid_engine_service.optimizer import validate_constraints
from common.dsm_policy import get_active_policy
from common.forecasts import latest_forecasts
from common.schemas import BidItem, ConstraintViolation
from risk_service.engine import assess_risk

from .checks import run_pre_trade_checks


class InvalidBidSet(ValueError):
    """The bid set cannot be evaluated at all, as opposed to failing a check."""


async def evaluate_bid_set(
    db: AsyncSession,
    *,
    target_date: str,
    segment: str,
    strategy: str,
    bids: Sequence[BidItem],
) -> dict:
    if not bids:
        raise InvalidBidSet("No bids provided.")
    wrong_segment = sorted({b.block for b in bids if b.segment != segment})
    if wrong_segment:
        raise InvalidBidSet(f"Blocks {wrong_segment[:10]} are not {segment} bids.")

    policy = get_active_policy()
    forecasts = await latest_forecasts(db, target_date, segment)

    violations: dict[int, list[ConstraintViolation]] = defaultdict(list)
    for b in bids:
        violations[b.block].extend(
            validate_constraints(b.block, b.price, b.volume_mw, segment, policy)
        )

    risk = assess_risk(bids, forecasts, policy)
    result = run_pre_trade_checks(bids, forecasts, violations, risk, strategy, policy)
    return {
        **result,
        "policy_id": policy.regulation_id,
        "risk": risk,
        "violations": [v.model_dump() for items in violations.values() for v in items],
    }
