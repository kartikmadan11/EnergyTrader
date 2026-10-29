"""
Pre-trade risk for a bid set: procurement cost-at-risk and DSM exposure.

Units: prices INR/kWh, volumes MW per 15-minute block, money INR.

Cost-at-risk (var_95)
    A cleared block costs volume x hours x 1000 x MCP.
    Forecast intervals are predicted_price +/- 1.96 sigma, so each block's MCP is treated
    as normal with that sigma.
    Block forecast errors are assumed perfectly correlated, which makes the portfolio
    sigma the sum of block sigmas and gives a conservative upper bound.
    var_95 is the one-sided 95% cost overrun versus the forecast.

DSM exposure
    Actual drawal is assumed to deviate from the schedule by the forecast's relative
    interval half-width (clamped to 2-25%), as a proxy for volume uncertainty.
    expected_dsm_penalty charges that deviation with the active policy's tiered rates.
    worst_case_penalty is a stress test: 30% deviation on every block at
    min(predicted price, price ceiling).
"""

from __future__ import annotations

import os
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from statistics import NormalDist
from typing import Protocol

from common.config import BLOCK_DURATION_MIN
from common.dsm_policy import DSMPolicy

Z_95 = NormalDist().inv_cdf(0.95)
FORECAST_INTERVAL_Z = 1.96
STRESS_DEVIATION = 0.30
FALLBACK_SIGMA_FRACTION = 0.08
VOLUME_UNCERTAINTY_RANGE = (0.02, 0.25)

DEFAULT_VAR_THRESHOLD = float(os.getenv("RISK_VAR_THRESHOLD_INR", "500000"))

_HOURS = BLOCK_DURATION_MIN / 60.0


class _Bid(Protocol):
    block: int
    price: float
    volume_mw: float


class _Forecast(Protocol):
    predicted_price: float
    confidence_low: float | None
    confidence_high: float | None


@dataclass(frozen=True)
class BlockRisk:
    block: int
    bid_price: float
    volume_mw: float
    predicted_price: float
    sigma: float
    has_forecast: bool


def block_risks(bids: Iterable[_Bid], forecasts: Mapping[int, _Forecast]) -> list[BlockRisk]:
    """
    Pair each bid with its forecast distribution.

    Blocks without a stored forecast use the bid price as the expected MCP and
    FALLBACK_SIGMA_FRACTION of it as sigma.
    """
    rows = []
    for bid in bids:
        fc = forecasts.get(bid.block)
        if fc is not None and fc.confidence_low is not None and fc.confidence_high is not None:
            predicted = fc.predicted_price
            sigma = max(fc.confidence_high - fc.confidence_low, 0.0) / (2 * FORECAST_INTERVAL_Z)
            has_forecast = True
        else:
            predicted = fc.predicted_price if fc is not None else bid.price
            sigma = FALLBACK_SIGMA_FRACTION * predicted
            has_forecast = fc is not None
        rows.append(
            BlockRisk(
                block=bid.block,
                bid_price=bid.price,
                volume_mw=bid.volume_mw,
                predicted_price=predicted,
                sigma=sigma,
                has_forecast=has_forecast,
            )
        )
    return rows


def cost_at_risk(rows: list[BlockRisk], z: float = Z_95) -> float:
    """One-sided cost overrun versus forecast at the confidence implied by *z*."""
    portfolio_sigma = sum(r.volume_mw * _HOURS * 1000 * r.sigma for r in rows)
    return round(z * portfolio_sigma, 2)


def volume_uncertainty(rows: list[BlockRisk]) -> float:
    """Average relative forecast half-width, clamped to VOLUME_UNCERTAINTY_RANGE."""
    lo, hi = VOLUME_UNCERTAINTY_RANGE
    priced = [r for r in rows if r.predicted_price > 0]
    if not priced:
        return lo
    avg = sum(FORECAST_INTERVAL_Z * r.sigma / r.predicted_price for r in priced) / len(priced)
    return min(max(avg, lo), hi)


def dsm_exposure(rows: list[BlockRisk], policy: DSMPolicy) -> dict:
    """Expected and stress-case DSM charges for the bid set under *policy*."""
    uncertainty = volume_uncertainty(rows)
    expected = 0.0
    worst = 0.0
    penalized = 0
    for r in rows:
        charge = policy.penalty_cost(
            volume_mw=r.volume_mw * (1.0 + uncertainty),
            scheduled_mw=r.volume_mw,
            price=r.predicted_price,
            duration_hours=_HOURS,
        )
        expected += charge
        penalized += charge > 0
        worst += policy.penalty_cost(
            volume_mw=r.volume_mw * (1.0 + STRESS_DEVIATION),
            scheduled_mw=r.volume_mw,
            price=min(r.predicted_price, policy.price_ceiling),
            duration_hours=_HOURS,
        )
    return {
        "expected": round(expected, 2),
        "worst_case": round(worst, 2),
        "penalized_blocks": penalized,
        "volume_uncertainty": round(uncertainty, 4),
    }


def assess_risk(
    bids: Iterable[_Bid],
    forecasts: Mapping[int, _Forecast],
    policy: DSMPolicy,
    var_threshold: float = DEFAULT_VAR_THRESHOLD,
) -> dict:
    """Full pre-trade risk assessment for a bid set."""
    rows = block_risks(bids, forecasts)
    var_95 = cost_at_risk(rows)
    dsm = dsm_exposure(rows, policy)
    total_exposure = round(var_95 + dsm["expected"], 2)

    alert_triggered = total_exposure > var_threshold
    alert_details = None
    if alert_triggered:
        alert_details = {
            "threshold": var_threshold,
            "total_exposure": total_exposure,
            "message": (
                f"Total exposure INR {total_exposure:,.0f} exceeds threshold INR {var_threshold:,.0f}"
            ),
            "breakdown": {"var_95": var_95, "expected_penalty": dsm["expected"]},
        }

    return {
        "var_95": var_95,
        "expected_dsm_penalty": dsm["expected"],
        "worst_case_penalty": dsm["worst_case"],
        "total_exposure": total_exposure,
        "alert_triggered": alert_triggered,
        "alert_details": alert_details,
        "var_threshold": var_threshold,
        "forecast_coverage": sum(r.has_forecast for r in rows),
        "policy_id": policy.regulation_id,
    }
