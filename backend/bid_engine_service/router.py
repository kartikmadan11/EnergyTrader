import uuid

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from approval_service.service import InvalidBidSet, evaluate_bid_set
from common.config import BLOCK_DURATION_MIN, STRATEGY_PROFILES
from common.database import get_db
from common.dsm_policy import get_active_policy
from common.forecasts import as_optimizer_input, latest_forecasts
from common.models import AuditLog, Bid, PriceHistory
from common.schemas import BidItem, BidRecommendation

from .optimizer import generate_recommendations, validate_constraints

router = APIRouter(prefix="/bids", tags=["Bid Engine"])

_KWH_PER_MW_BLOCK = BLOCK_DURATION_MIN / 60.0 * 1000


async def _optimizer_input(db: AsyncSession, target_date: str, segment: str) -> list[dict]:
    forecasts = await latest_forecasts(db, target_date, segment)
    if not forecasts:
        raise HTTPException(
            400, f"No forecasts for {target_date} / {segment}. Run /forecast/predict first."
        )
    return as_optimizer_input(forecasts)


@router.get("/recommend", response_model=list[BidRecommendation])
async def recommend_bids(
    target_date: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"),
    strategy: str = Query("balanced", pattern=r"^(conservative|balanced|aggressive)$"),
    segment: str = Query(..., pattern=r"^(DAM|RTM|TAM)$"),
    demand_mw: float = Query(500.0, ge=0),
    price_offset: float | None = Query(
        default=None, ge=-5.0, le=5.0, description="Override strategy price offset"
    ),
    risk_tolerance: float | None = Query(
        default=None,
        ge=0.0,
        le=1.0,
        description="Override strategy risk tolerance (0=conservative, 1=aggressive)",
    ),
    volume_scale: float | None = Query(
        default=None, ge=0.1, le=3.0, description="Override strategy volume scale"
    ),
    per_block_cap_factor: float = Query(
        default=4.0,
        ge=1.0,
        le=20.0,
        description="Max volume per block as multiple of avg load",
    ),
    lambda1_base: float | None = Query(
        default=None,
        ge=0.1,
        le=50.0,
        description="Override DSM penalty weight base (λ₁). Default from solver_config.",
    ),
    lambda2_base: float | None = Query(
        default=None,
        ge=0.1,
        le=50.0,
        description="Override forecast uncertainty weight base (λ₂). Default from solver_config.",
    ),
    db: AsyncSession = Depends(get_db),
):
    """LP-optimized bid recommendations for all 96 blocks of a delivery date."""
    recs = generate_recommendations(
        await _optimizer_input(db, target_date, segment),
        strategy,
        demand_mw,
        segment,
        price_offset_override=price_offset,
        risk_tolerance_override=risk_tolerance,
        volume_scale_override=volume_scale,
        per_block_cap_factor=per_block_cap_factor,
        lambda1_base_override=lambda1_base,
        lambda2_base_override=lambda2_base,
    )
    return [BidRecommendation(**r) for r in recs]


@router.post("/submit")
async def submit_bids(
    target_date: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"),
    strategy: str = Query("balanced", pattern=r"^(conservative|balanced|aggressive)$"),
    segment: str = Query(..., pattern=r"^(DAM|RTM|TAM)$"),
    bids: list[BidItem] = Body(...),
    db: AsyncSession = Depends(get_db),
):
    """
    Submit a bid set for a delivery date and segment.

    The set is re-evaluated server-side and rejected with 422 unless the pre-trade
    checks allow submission.
    """
    try:
        evaluation = await evaluate_bid_set(
            db, target_date=target_date, segment=segment, strategy=strategy, bids=bids
        )
    except InvalidBidSet as exc:
        raise HTTPException(422, str(exc)) from exc

    if not evaluation["can_submit"]:
        raise HTTPException(
            422,
            detail={
                "message": f"Submission blocked by pre-trade checks. {evaluation['summary']}",
                "verdict": evaluation["verdict"],
                "checks": evaluation["checks"],
            },
        )

    session_id = str(uuid.uuid4())
    for item in bids:
        db.add(
            Bid(
                session_id=session_id,
                target_date=target_date,
                block=item.block,
                segment=segment,
                strategy=strategy,
                price=item.price,
                volume_mw=item.volume_mw,
                is_overridden=item.is_overridden,
                override_reason=item.override_reason,
                status="submitted",
            )
        )
    db.add(
        AuditLog(
            session_id=session_id,
            action="submit",
            entity_type="bid",
            details={
                "target_date": target_date,
                "segment": segment,
                "strategy": strategy,
                "policy_id": evaluation["policy_id"],
                "verdict": evaluation["verdict"],
                "score": evaluation["score"],
                "bid_count": len(bids),
                "total_volume_mw": round(sum(b.volume_mw for b in bids), 2),
            },
        )
    )
    await db.commit()

    return {
        "session_id": session_id,
        "target_date": target_date,
        "segment": segment,
        "bid_count": len(bids),
        "verdict": evaluation["verdict"],
        "score": evaluation["score"],
        "status": "submitted",
    }


@router.post("/validate")
async def validate_bids(bids: list[BidItem] = Body(...)):
    """Validate bids against the active policy's price band and technical minimum."""
    policy = get_active_policy()
    violations = [
        v
        for item in bids
        for v in validate_constraints(item.block, item.price, item.volume_mw, item.segment, policy)
    ]
    return {
        "valid": not violations,
        "violation_count": len(violations),
        "violations": [v.model_dump() for v in violations],
    }


@router.get("/compare-strategies")
async def compare_strategies(
    target_date: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"),
    segment: str = Query(..., pattern=r"^(DAM|RTM|TAM)$"),
    demand_mw: float = Query(500.0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    """
    Run all three strategies against the same forecast and, when actual prices exist,
    simulate clearing (a buy bid clears when bid price >= MCP).

    basket_rate is the volume-weighted MCP of cleared bids.
    baseline_basket_rate is the volume-weighted MCP across every bid block, i.e. a
    price taker that clears everything.
    cost_savings is (baseline - basket) x cleared energy, in INR.
    """
    forecast_input = await _optimizer_input(db, target_date, segment)

    result = await db.execute(
        select(PriceHistory)
        .where(PriceHistory.date == target_date, PriceHistory.segment == segment)
        .order_by(PriceHistory.block)
    )
    actuals = {r.block: r.mcp for r in result.scalars().all()}
    has_actuals = bool(actuals)

    strategies_out = []
    for strategy in ("conservative", "balanced", "aggressive"):
        recs = generate_recommendations(forecast_input, strategy, demand_mw, segment)

        cleared_cost = cleared_kwh = baseline_cost = baseline_kwh = 0.0
        hit_count = 0
        block_details = []
        for r in recs:
            kwh = r["volume_mw"] * _KWH_PER_MW_BLOCK
            actual = actuals.get(r["block"])
            cleared = actual is not None and r["price"] >= actual
            if actual is not None:
                baseline_cost += actual * kwh
                baseline_kwh += kwh
                if cleared:
                    cleared_cost += actual * kwh
                    cleared_kwh += kwh
                    hit_count += 1
            block_details.append(
                {
                    "block": r["block"],
                    "bid_price": r["price"],
                    "volume_mw": r["volume_mw"],
                    "cleared": cleared,
                    "actual_price": round(actual, 4) if actual is not None else None,
                }
            )

        basket_rate = cleared_cost / cleared_kwh if cleared_kwh else 0.0
        baseline_basket = baseline_cost / baseline_kwh if baseline_kwh else 0.0
        basket_change = (
            (basket_rate - baseline_basket) / baseline_basket * 100
            if cleared_kwh and baseline_basket
            else 0.0
        )
        profile = STRATEGY_PROFILES[strategy]

        strategies_out.append(
            {
                "strategy": strategy,
                "risk_tolerance": profile["risk_tolerance"],
                "price_offset": profile["price_offset"],
                "volume_scale": profile["volume_scale"],
                "avg_bid_price": round(sum(r["price"] for r in recs) / max(len(recs), 1), 4),
                "total_volume_mw": round(sum(r["volume_mw"] for r in recs), 1),
                "total_bid_value": round(
                    sum(r["price"] * r["volume_mw"] * _KWH_PER_MW_BLOCK for r in recs), 2
                ),
                "estimated_dsm_penalty": round(sum(r["dsm_penalty_estimate"] for r in recs), 2),
                "violation_count": sum(len(r["constraint_violations"]) for r in recs),
                "hit_rate": round(hit_count / len(recs) * 100, 2) if recs and has_actuals else 0.0,
                "basket_rate": round(basket_rate, 4),
                "baseline_basket_rate": round(baseline_basket, 4),
                "basket_rate_change_pct": round(basket_change, 2),
                "cost_savings": (
                    round((baseline_basket - basket_rate) * cleared_kwh, 2) if has_actuals else None
                ),
                "blocks": block_details,
            }
        )

    return {
        "target_date": target_date,
        "segment": segment,
        "demand_mw": demand_mw,
        "has_actuals": has_actuals,
        "strategies": strategies_out,
    }


@router.get("/tune")
async def auto_tune_lambdas(
    target_date: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"),
    strategy: str = Query("balanced", pattern=r"^(conservative|balanced|aggressive)$"),
    segment: str = Query(..., pattern=r"^(DAM|RTM|TAM)$"),
    demand_mw: float = Query(500.0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    """
    Grid-search λ₁ x λ₂ and return the pair with the best score, where

        score = total bid value (INR) - 2 x estimated DSM penalty (INR)
    """
    forecast_input = await _optimizer_input(db, target_date, segment)

    lambda1_grid = [0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0]
    lambda2_grid = [0.5, 0.75, 1.0, 1.25, 1.5]

    grid_results = []
    for l1 in lambda1_grid:
        for l2 in lambda2_grid:
            recs = generate_recommendations(
                forecast_input,
                strategy,
                demand_mw,
                segment,
                lambda1_base_override=l1,
                lambda2_base_override=l2,
            )
            total_bid_value = sum(r["price"] * r["volume_mw"] * _KWH_PER_MW_BLOCK for r in recs)
            total_dsm = sum(r["dsm_penalty_estimate"] for r in recs)
            grid_results.append(
                {
                    "lambda1_base": l1,
                    "lambda2_base": l2,
                    "total_bid_value": round(total_bid_value, 2),
                    "total_dsm_penalty": round(total_dsm, 2),
                    "score": round(total_bid_value - 2.0 * total_dsm, 2),
                }
            )

    # Highest score wins; ties go to the smaller weights (the first grid entry).
    ranked = sorted(grid_results, key=lambda x: x["score"], reverse=True)
    best = ranked[0]
    return {
        "best_lambda1_base": best["lambda1_base"],
        "best_lambda2_base": best["lambda2_base"],
        "best_score": best["score"],
        "grid": ranked,
    }
