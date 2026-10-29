import logging
import time

from fastapi import APIRouter, BackgroundTasks, Body, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from common.database import async_session, get_db
from common.dsm_policy import get_active_policy
from common.forecasts import latest_forecasts
from common.models import RiskSnapshot
from common.schemas import BidItem, RiskResult

from .engine import DEFAULT_VAR_THRESHOLD, assess_risk

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/risk", tags=["Risk"])


async def _persist_risk_snapshot(session_id: str, segment: str, risk: dict) -> None:
    """Background task: store the assessment in its own session after the response is sent."""
    async with async_session() as db:
        db.add(
            RiskSnapshot(
                session_id=session_id,
                segment=segment,
                var_95=risk["var_95"],
                expected_dsm_penalty=risk["expected_dsm_penalty"],
                worst_case_penalty=risk["worst_case_penalty"],
                total_exposure=risk["total_exposure"],
                alert_triggered=risk["alert_triggered"],
                alert_details=risk["alert_details"],
            )
        )
        await db.commit()


@router.post("/assess", response_model=RiskResult)
async def assess_bid_risk(
    background_tasks: BackgroundTasks,
    session_id: str = Query(..., max_length=36),
    target_date: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"),
    segment: str = Query(..., pattern=r"^(DAM|RTM|TAM)$"),
    bids: list[BidItem] = Body(...),
    var_threshold: float = Query(DEFAULT_VAR_THRESHOLD, gt=0),
    db: AsyncSession = Depends(get_db),
):
    """Cost-at-risk, DSM exposure and threshold alert for a bid set."""
    t0 = time.perf_counter()

    if not bids:
        raise HTTPException(400, "No bids provided.")

    forecasts = await latest_forecasts(db, target_date, segment)
    risk = assess_risk(bids, forecasts, get_active_policy(), var_threshold=var_threshold)

    elapsed_ms = (time.perf_counter() - t0) * 1000
    background_tasks.add_task(_persist_risk_snapshot, session_id, segment, risk)

    response = RiskResult(segment=segment, **risk)
    json_response = JSONResponse(content=response.model_dump())
    json_response.headers["X-Risk-Latency-Ms"] = f"{elapsed_ms:.1f}"
    return json_response


@router.get("/threshold")
async def get_threshold():
    """Default risk alert threshold (INR), configurable with RISK_VAR_THRESHOLD_INR."""
    return {"var_threshold": DEFAULT_VAR_THRESHOLD}
