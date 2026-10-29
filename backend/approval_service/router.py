"""
Pre-trade checks endpoint.

POST /bids/request-approval evaluates a bid set server-side (constraints, risk and the
checks in checks.py), records the verdict in the audit log and returns it.
"""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from common.database import get_db
from common.models import AuditLog
from common.schemas import BidItem

from .service import InvalidBidSet, evaluate_bid_set

router = APIRouter(prefix="/bids", tags=["Pre-trade checks"])


@router.post("/request-approval")
async def request_approval(
    session_id: str = Query(..., max_length=36),
    target_date: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"),
    segment: str = Query(..., pattern=r"^(DAM|RTM|TAM)$"),
    strategy: str = Query(default="balanced", pattern=r"^(conservative|balanced|aggressive)$"),
    bids: list[BidItem] = Body(...),
    db: AsyncSession = Depends(get_db),
):
    """Run pre-trade checks on a bid set and return a scored verdict."""
    try:
        evaluation = await evaluate_bid_set(
            db, target_date=target_date, segment=segment, strategy=strategy, bids=bids
        )
    except InvalidBidSet as exc:
        raise HTTPException(422, str(exc)) from exc

    db.add(
        AuditLog(
            session_id=session_id,
            user="system",
            action="pre_trade_check",
            entity_type="bid",
            details={
                "target_date": target_date,
                "segment": segment,
                "strategy": strategy,
                "policy_id": evaluation["policy_id"],
                "verdict": evaluation["verdict"],
                "score": evaluation["score"],
                "can_submit": evaluation["can_submit"],
                "bid_count": len(bids),
            },
        )
    )
    await db.commit()

    return {
        "session_id": session_id,
        "target_date": target_date,
        "segment": segment,
        "strategy": strategy,
        **evaluation,
    }
