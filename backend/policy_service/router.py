"""
DSM policy endpoints.

  GET  /policy/list              all policies with an is_active flag
  GET  /policy/active            the active policy
  POST /policy/activate/{id}     switch the active policy
  GET  /policy/compare           field-level diff of two policies
  PUT  /policy/{id}              edit a policy's parameters
"""

import logging

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from common.database import get_db
from common.dsm_policy import (
    DSMPolicy,
    get_active_policy,
    list_policies,
    load_policy,
    set_active_policy,
    update_policy,
)
from common.models import AuditLog

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/policy", tags=["Policy"])


@router.get("/list")
async def get_all_policies() -> list[dict]:
    """All available DSM policies, newest first, with an is_active flag."""
    active = get_active_policy()
    return [
        {**p.model_dump(), "is_active": p.regulation_id == active.regulation_id}
        for p in list_policies()
    ]


@router.get("/active")
async def get_active() -> dict:
    """The active DSM policy."""
    return {**get_active_policy().model_dump(), "is_active": True}


@router.post("/activate/{regulation_id}")
async def activate_policy(regulation_id: str, db: AsyncSession = Depends(get_db)) -> dict:
    """
    Switch the active DSM policy.

    Applies to every subsequent optimization, constraint check and risk assessment,
    and persists across restarts.
    """
    previous = get_active_policy().regulation_id
    try:
        policy = set_active_policy(regulation_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    db.add(
        AuditLog(
            action="policy_activate",
            entity_type="policy",
            details={"from": previous, "to": regulation_id},
        )
    )
    await db.commit()
    return {
        "message": f"Active policy switched to '{policy.name}'",
        "policy": policy.model_dump(),
    }


# For each regulatory parameter: does a higher value make the regime stricter for a participant?
_HIGHER_IS_STRICTER: dict[str, bool] = {
    "price_floor": True,
    "price_ceiling": False,
    "deviation_band": False,
    "penalty_rate": True,
    "severe_deviation_threshold": False,
    "severe_penalty_multiplier": True,
    "technical_minimum_mw": True,
}


@router.get("/compare")
async def compare_policies(policy_a: str, policy_b: str) -> dict:
    """
    Return a field-level diff between two policies.

    Each diff carries a direction ("stricter" or "looser") describing what moving
    from policy_a to policy_b means for a market participant.
    """
    try:
        pa: DSMPolicy = load_policy(policy_a)
        pb: DSMPolicy = load_policy(policy_b)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    diffs = []
    for field, higher_is_stricter in _HIGHER_IS_STRICTER.items():
        va = getattr(pa, field)
        vb = getattr(pb, field)
        if va == vb:
            continue
        pct_change = round((vb - va) / va * 100, 1) if va != 0 else None
        stricter = (vb > va) == higher_is_stricter
        diffs.append(
            {
                "field": field,
                "policy_a_value": va,
                "policy_b_value": vb,
                "pct_change": pct_change,
                "direction": "stricter" if stricter else "looser",
            }
        )

    stricter_count = sum(d["direction"] == "stricter" for d in diffs)
    looser_count = len(diffs) - stricter_count
    if not diffs:
        summary = f"'{pa.name}' and '{pb.name}' have identical parameters."
    else:
        summary = (
            f"Moving from '{pa.name}' to '{pb.name}' changes {len(diffs)} parameter(s): "
            f"{stricter_count} stricter, {looser_count} looser."
        )

    return {
        "policy_a": pa.model_dump(),
        "policy_b": pb.model_dump(),
        "diffs": diffs,
        "summary": summary,
    }


@router.put("/{regulation_id}")
async def update_policy_endpoint(
    regulation_id: str,
    body: dict = Body(...),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Edit an existing policy's parameters in place.

    The regulation_id is the file name and cannot be changed.
    Edits to the active policy apply to every subsequent optimization.
    """
    try:
        before = load_policy(regulation_id).model_dump()
        policy = update_policy(regulation_id, body)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors(include_url=False)) from exc

    after = policy.model_dump()
    db.add(
        AuditLog(
            action="policy_update",
            entity_type="policy",
            details={
                "regulation_id": regulation_id,
                "changes": {
                    k: {"from": before[k], "to": after[k]}
                    for k in after
                    if before.get(k) != after[k]
                },
            },
        )
    )
    await db.commit()
    return {
        "message": f"Policy '{regulation_id}' updated",
        "policy": {
            **after,
            "is_active": policy.regulation_id == get_active_policy().regulation_id,
        },
    }
