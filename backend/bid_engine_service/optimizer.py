"""
Bid optimization engine using linear programming (PuLP).

Objective (minimize, since PuLP minimizes):
  Σ_b [ -price[b]·v[b]
        + λ1·(d_over[b] + d_under[b])·price[b]·penalty_rate          # base DSM penalty
        + λ1·(s_over[b] + s_under[b])·price[b]·penalty_rate·(severe_multiplier-1)  # severe surcharge
        + λ2·ci_width[b]·v[b] ]                                        # uncertainty penalty

Decision variables:
  v[b]       ≥ 0        volume in MW per block
  d_over[b]  ≥ 0        MW above (1 + deviation_band)×load[b]   - base penalty zone
  d_under[b] ≥ 0        MW below (1 - deviation_band)×load[b]   - base penalty zone
  s_over[b]  ≥ 0        MW above (1 + severe_threshold)×load[b] - severe surcharge zone
  s_under[b] ≥ 0        MW below (1 - severe_threshold)×load[b] - severe surcharge zone

Hard constraints:
  Σ v[b] ≤ total_demand_mw × volume_scale
  v[b]   ≤ per_block_cap                       (no single-block concentration)
  v[b]   ≥ technical_minimum_mw  (DAM/RTM)     (CERC technical minimum from policy)
  d_over[b]  ≥ v[b] - (1+deviation_band)·load  (linearize base over-deviation)
  d_under[b] ≥ (1-deviation_band)·load - v[b]  (linearize base under-deviation)
  s_over[b]  ≥ v[b] - (1+severe_threshold)·load (linearize severe over-deviation)
  s_under[b] ≥ (1-severe_threshold)·load - v[b] (linearize severe under-deviation)

All five policy fields feed the LP: deviation_band, penalty_rate,
severe_deviation_threshold, severe_penalty_multiplier, technical_minimum_mw.
Price clamping uses price_floor / price_ceiling.
"""

import logging

from pulp import (
    HiGHS,
    LpMinimize,
    LpProblem,
    LpStatusOptimal,
    LpVariable,
    lpSum,
)
from pulp import (
    value as lp_value,
)

from common.config import (
    BLOCK_DURATION_MIN,
    NUM_BLOCKS,
    STRATEGY_PROFILES,
)
from common.dsm_policy import DSMPolicy, get_active_policy
from common.schemas import ConstraintViolation
from common.solver_config import LAMBDA1_BASE, LAMBDA2_BASE

logger = logging.getLogger(__name__)

# Max volume a single block may receive (4× average = 4/96 of daily demand).
# Prevents the LP from dumping all volume into the single cheapest block.
_PER_BLOCK_CAP_FACTOR = 4.0


def validate_constraints(
    block: int,
    price: float,
    volume_mw: float,
    segment: str,
    policy: DSMPolicy | None = None,
) -> list[ConstraintViolation]:
    """Check a single bid against DSM and market constraints."""
    if policy is None:
        policy = get_active_policy()

    violations = []

    if price < policy.price_floor:
        violations.append(
            ConstraintViolation(
                block=block,
                field="price",
                value=price,
                limit=policy.price_floor,
                message=f"Price {price:.2f} below DSM floor {policy.price_floor} [{policy.name}]",
            )
        )

    if price > policy.price_ceiling:
        violations.append(
            ConstraintViolation(
                block=block,
                field="price",
                value=price,
                limit=policy.price_ceiling,
                message=f"Price {price:.2f} exceeds DSM ceiling {policy.price_ceiling} [{policy.name}]",
            )
        )

    if volume_mw < 0:
        violations.append(
            ConstraintViolation(
                block=block,
                field="volume_mw",
                value=volume_mw,
                limit=0.0,
                message="Volume cannot be negative",
            )
        )

    # Technical minimum from active policy
    if segment in ("DAM", "RTM") and 0 < volume_mw < policy.technical_minimum_mw:
        violations.append(
            ConstraintViolation(
                block=block,
                field="volume_mw",
                value=volume_mw,
                limit=policy.technical_minimum_mw,
                message=(
                    f"Volume {volume_mw:.2f} MW below technical minimum of "
                    f"{policy.technical_minimum_mw} MW for {segment} [{policy.name}]"
                ),
            )
        )

    return violations


def generate_recommendations(
    forecasts: list[dict],
    strategy: str,
    demand_mw: float,
    segment: str,
    price_offset_override: float | None = None,
    risk_tolerance_override: float | None = None,
    volume_scale_override: float | None = None,
    per_block_cap_factor: float = _PER_BLOCK_CAP_FACTOR,
    lambda1_base_override: float | None = None,
    lambda2_base_override: float | None = None,
) -> list[dict]:
    """
    Generate LP-optimized bid recommendations for all 96 blocks.

    Bid price is fixed per block (predicted MCP ± strategy offset × volatility).
    Volume allocation is the LP decision variable, optimized to maximize cleared
    value while penalizing DSM deviation risk and forecast uncertainty.
    """
    # Load the active DSM policy - this is the single source of truth for
    # penalty rates, deviation bands, and price limits used in the LP.
    policy = get_active_policy()

    profile = STRATEGY_PROFILES[strategy]
    price_offset = (
        price_offset_override if price_offset_override is not None else profile["price_offset"]
    )
    risk_tolerance = (
        risk_tolerance_override
        if risk_tolerance_override is not None
        else profile["risk_tolerance"]
    )
    volume_scale = (
        volume_scale_override if volume_scale_override is not None else profile["volume_scale"]
    )

    # λ weights are the solver base weights scaled by the strategy's risk_tolerance.
    # The regulation itself enters the objective through penalty_rate and the bands.
    lambda1 = (1.0 - risk_tolerance) * (
        lambda1_base_override if lambda1_base_override is not None else LAMBDA1_BASE
    )
    lambda2 = (1.0 - risk_tolerance) * (
        lambda2_base_override if lambda2_base_override is not None else LAMBDA2_BASE
    )

    # Uniform scheduled load per block (MW) - baseline for DSM deviation check
    load_per_block = demand_mw / NUM_BLOCKS
    per_block_cap = load_per_block * per_block_cap_factor

    # Pre-compute bid prices and CI widths (these are fixed, not LP variables)
    block_data: dict[int, dict] = {}
    for fc in forecasts:
        b = fc["block"]
        pred = fc["predicted_price"]
        # Stored forecast columns are nullable, so treat None like a missing key.
        vol = fc.get("volatility")
        if vol is None:
            vol = pred * 0.1
        ci_low = fc.get("confidence_low")
        ci_high = fc.get("confidence_high")
        if ci_low is None or ci_high is None:
            ci_low, ci_high = pred - vol, pred + vol
        ci_width = max(ci_high - ci_low, 0.0)

        bid_price = pred + price_offset * vol
        bid_price = max(bid_price, policy.price_floor + 0.01)
        bid_price = min(bid_price, policy.price_ceiling - 0.01)

        block_data[b] = {
            "pred_price": pred,
            "bid_price": bid_price,
            "ci_width": ci_width,
            "volatility": vol,
        }

    blocks = sorted(block_data.keys())

    # ── Build LP ────────────────────────────────────────────────────────
    prob = LpProblem("bid_optimization", LpMinimize)

    # Decision variables
    v = {b: LpVariable(f"v_{b}", lowBound=0.0, upBound=per_block_cap) for b in blocks}
    d_over = {b: LpVariable(f"d_over_{b}", lowBound=0.0) for b in blocks}
    d_under = {b: LpVariable(f"d_under_{b}", lowBound=0.0) for b in blocks}
    # Severe-deviation auxiliaries (piecewise tier above severe_deviation_threshold)
    s_over = {b: LpVariable(f"s_over_{b}", lowBound=0.0) for b in blocks}
    s_under = {b: LpVariable(f"s_under_{b}", lowBound=0.0) for b in blocks}

    severe_surcharge_factor = policy.penalty_rate * (policy.severe_penalty_multiplier - 1.0)

    # Objective: maximize cleared value − base DSM penalty − severe surcharge − uncertainty
    prob += lpSum(
        -block_data[b]["bid_price"] * v[b]
        + lambda1 * (d_over[b] + d_under[b]) * block_data[b]["bid_price"] * policy.penalty_rate
        + lambda1 * (s_over[b] + s_under[b]) * block_data[b]["bid_price"] * severe_surcharge_factor
        + lambda2 * block_data[b]["ci_width"] * v[b]
        for b in blocks
    )

    # Constraint 1: total volume ≤ total daily demand × volume_scale
    prob += lpSum(v[b] for b in blocks) <= demand_mw * volume_scale

    for b in blocks:
        load = load_per_block

        # Constraint 2: base DSM linearization - over-deviation
        # d_over[b] ≥ v[b] - (1 + deviation_band) × load
        prob += d_over[b] >= v[b] - (1.0 + policy.deviation_band) * load

        # Constraint 3: base DSM linearization - under-deviation
        # d_under[b] ≥ (1 - deviation_band) × load - v[b]
        prob += d_under[b] >= (1.0 - policy.deviation_band) * load - v[b]

        # Constraint 4 & 5: severe-deviation piecewise tier
        # s_over[b]  ≥ v[b] - (1 + severe_threshold) × load
        # s_under[b] ≥ (1 - severe_threshold) × load - v[b]
        prob += s_over[b] >= v[b] - (1.0 + policy.severe_deviation_threshold) * load
        prob += s_under[b] >= (1.0 - policy.severe_deviation_threshold) * load - v[b]

        # Constraint 6: CERC technical minimum for DAM/RTM (from policy)
        if segment in ("DAM", "RTM") and load_per_block >= policy.technical_minimum_mw:
            prob += v[b] >= policy.technical_minimum_mw

    # ── Solve ───────────────────────────────────────────────────────────
    status = prob.solve(HiGHS(msg=False))

    # Fall back to uniform allocation if the LP is infeasible or unbounded
    if status != LpStatusOptimal:
        logger.warning(
            "LP solver returned status %s for strategy=%s segment=%s - "
            "falling back to uniform allocation",
            status,
            strategy,
            segment,
        )
        uniform_vol = demand_mw / NUM_BLOCKS
        lp_volumes = {b: uniform_vol for b in blocks}
    else:
        lp_volumes = {b: max(lp_value(v[b]) or 0.0, 0.0) for b in blocks}

    # ── Build response ──────────────────────────────────────────────────
    duration_hours = BLOCK_DURATION_MIN / 60.0
    recommendations = []

    for b in blocks:
        bd = block_data[b]
        vol_mw = round(lp_volumes[b], 1)

        # Apply technical minimum post-solve (safety clamp for edge cases)
        if segment in ("DAM", "RTM") and 0 < vol_mw < policy.technical_minimum_mw:
            vol_mw = policy.technical_minimum_mw

        # DSM penalty estimate - uses the tiered penalty_cost() from the active policy
        dsm_penalty_est = policy.penalty_cost(
            volume_mw=vol_mw,
            scheduled_mw=load_per_block,
            price=bd["bid_price"],
            duration_hours=duration_hours,
        )

        violations = validate_constraints(b, bd["bid_price"], vol_mw, segment, policy)

        recommendations.append(
            {
                "block": b,
                "segment": segment,
                "price": round(bd["bid_price"], 4),
                "volume_mw": vol_mw,
                "strategy": strategy,
                "dsm_penalty_estimate": dsm_penalty_est,
                "uncertainty_score": round(bd["ci_width"], 4),
                "constraint_violations": [v_.model_dump() for v_ in violations],
                "active_policy": policy.regulation_id,
                "effective_lambda1": round(lambda1, 4),
                "effective_lambda2": round(lambda2, 4),
            }
        )

    return sorted(recommendations, key=lambda r: r["block"])
