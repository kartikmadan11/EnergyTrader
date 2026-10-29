from datetime import UTC

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from common.config import BLOCK_DURATION_MIN
from common.database import get_db
from common.dsm_policy import get_active_policy
from common.forecasts import latest_forecasts
from common.models import AuditLog, Bid, PriceHistory
from common.schemas import PostMarketBlock, PostMarketSummary
from forecast_service import metrics

router = APIRouter(prefix="/audit", tags=["Audit"])


@router.get("/log")
async def get_audit_log(
    session_id: str | None = Query(None),
    action: str | None = Query(None),
    limit: int = Query(100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    """Audit entries written by the server, newest first."""
    q = select(AuditLog).order_by(AuditLog.id.desc()).limit(limit)
    if session_id:
        q = q.where(AuditLog.session_id == session_id)
    if action:
        q = q.where(AuditLog.action == action)

    entries = (await db.execute(q)).scalars().all()
    return [
        {
            "id": e.id,
            # SQLite CURRENT_TIMESTAMP is UTC but naive; tag it so clients convert correctly.
            "timestamp": e.timestamp.replace(tzinfo=UTC).isoformat() if e.timestamp else None,
            "session_id": e.session_id,
            "user": e.user,
            "action": e.action,
            "entity_type": e.entity_type,
            "entity_id": e.entity_id,
            "details": e.details,
        }
        for e in entries
    ]


@router.get("/post-market", response_model=PostMarketSummary)
async def post_market_analysis(
    target_date: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"),
    segment: str = Query(..., pattern=r"^(DAM|RTM|TAM)$"),
    session_id: str | None = Query(
        None, description="Bid session to analyze. Defaults to the latest submission for the date."
    ),
    db: AsyncSession = Depends(get_db),
):
    """
    Compare forecasts and submitted bids with the cleared market for a delivery date.

    A buy bid clears when bid price >= MCP.
    basket_rate is the volume-weighted MCP of cleared bids and baseline_basket_rate the
    volume-weighted MCP across every bid block.
    uncleared_dsm_exposure charges uncleared bid volume as deviation from a zero schedule
    under the active policy, i.e. the cost if that requirement were drawn from the grid.
    """
    result = await db.execute(
        select(PriceHistory)
        .where(PriceHistory.date == target_date, PriceHistory.segment == segment)
        .order_by(PriceHistory.block)
    )
    actuals = {r.block: r.mcp for r in result.scalars().all()}
    if not actuals:
        raise HTTPException(400, f"No actual price data for {target_date} / {segment}")

    preds = await latest_forecasts(db, target_date, segment)

    if session_id is None:
        session_id = (
            await db.execute(
                select(Bid.session_id)
                .where(Bid.target_date == target_date, Bid.segment == segment)
                .order_by(Bid.id.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
    bids_map: dict[int, Bid] = {}
    if session_id:
        result = await db.execute(
            select(Bid).where(
                Bid.session_id == session_id,
                Bid.target_date == target_date,
                Bid.segment == segment,
            )
        )
        bids_map = {b.block: b for b in result.scalars().all()}

    policy = get_active_policy()
    hours = BLOCK_DURATION_MIN / 60.0
    blocks: list[PostMarketBlock] = []
    hit_count = 0
    cleared_cost = cleared_kwh = baseline_cost = baseline_kwh = 0.0
    uncleared_dsm = 0.0

    if not preds and not bids_map:
        raise HTTPException(
            404, f"No stored forecast or submitted bids for {target_date} / {segment}"
        )

    for block_num in sorted(actuals):
        actual_price = actuals[block_num]
        pred = preds.get(block_num)
        bid = bids_map.get(block_num)
        if pred is None and bid is None:
            continue
        cleared = bid is not None and bid.price >= actual_price

        if bid is not None:
            kwh = bid.volume_mw * hours * 1000
            baseline_cost += actual_price * kwh
            baseline_kwh += kwh
            if cleared:
                hit_count += 1
                cleared_cost += actual_price * kwh
                cleared_kwh += kwh
            else:
                uncleared_dsm += policy.penalty_cost(
                    volume_mw=bid.volume_mw,
                    scheduled_mw=0.0,
                    price=actual_price,
                    duration_hours=hours,
                )

        error_pct = metrics.percentage_error(actual_price, pred.predicted_price) if pred else None
        blocks.append(
            PostMarketBlock(
                block=block_num,
                predicted_price=round(pred.predicted_price, 4) if pred else None,
                actual_price=round(actual_price, 4),
                bid_price=round(bid.price, 4) if bid is not None else None,
                bid_volume=round(bid.volume_mw, 1) if bid is not None else None,
                cleared=cleared,
                error=round(abs(pred.predicted_price - actual_price), 4) if pred else None,
                error_pct=round(error_pct, 2) if error_pct is not None else None,
            )
        )

    forecast_blocks = [b for b in blocks if b.predicted_price is not None]
    actual_arr = [b.actual_price for b in forecast_blocks]
    pred_arr = [b.predicted_price for b in forecast_blocks]
    mape = metrics.mape(actual_arr, pred_arr) if forecast_blocks else None
    bid_count = sum(b.bid_price is not None for b in blocks)
    basket_rate = cleared_cost / cleared_kwh if cleared_kwh else 0.0
    baseline_basket = baseline_cost / baseline_kwh if baseline_kwh else 0.0
    basket_change = (
        (basket_rate - baseline_basket) / baseline_basket * 100
        if cleared_kwh and baseline_basket
        else 0.0
    )

    return PostMarketSummary(
        target_date=target_date,
        segment=segment,
        session_id=session_id if bids_map else None,
        blocks=blocks,
        mape=round(mape, 2) if mape is not None else None,
        mae=round(metrics.mae(actual_arr, pred_arr), 4) if forecast_blocks else None,
        bid_hit_rate=round(hit_count / bid_count * 100, 2) if bid_count else 0.0,
        basket_rate=round(basket_rate, 4),
        baseline_basket_rate=round(baseline_basket, 4),
        basket_rate_change_pct=round(basket_change, 2),
        uncleared_dsm_exposure=round(uncleared_dsm, 2),
    )
